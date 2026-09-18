/**
 * ============================================================================
 * Device Fleet Management & Telemetry Ingestion Service (services/deviceService.js)
 * ============================================================================
 * Handles CRUD operations for smart bin hardware devices, real-time telemetry ingestion,
 * automated job generation upon threshold breaches, and camera image persistence
 * to Supabase Storage.
 *
 * Responsibilities:
 *  1. Telemetry Ingestion: Receives ultrasonic fill levels and ML classification events.
 *  2. Device State Sync: Upserts device records and updates compartment capacities.
 *  3. Image Storage: Decodes Base64 camera frames into JPEG buffers and uploads them
 *     to the Supabase Storage bucket 'bin_captures'.
 *  4. Event Auditing: Logs item sorting events (ProcessedItem) and operational milestones (DeviceEvent).
 *  5. Threshold Protection: Auto-generates High/Urgent CollectionJob tickets when fill >= 80%.
 */

const { prisma } = require('../lib/prisma');
const { supabase } = require('../middleware/auth');
const AppError = require('../utils/errorHandler');

class DeviceService {
  /**
   * Retrieves a paginated list of smart bins, optionally filtered by facility.
   * 
   * @param {string} [facilityId] - Facility UUID to filter devices.
   * @param {number} [page=1] - 1-indexed pagination page.
   * @param {number} [limit=10] - Number of devices per page.
   * @returns {Promise<{ devices: Array<object>, totalCount: number }>}
   */
  async getDevices(facilityId, page = 1, limit = 10) {
    const skip = (page - 1) * limit;
    const where = facilityId ? { facilityId } : {};

    const [devices, totalCount] = await Promise.all([
      prisma.device.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.device.count({ where }),
    ]);

    return { devices, totalCount };
  }

  /**
   * Evaluates a bin's fill level and automatically creates a collection job and alert
   * if capacity exceeds the 80% warning or 95% critical threshold.
   * 
   * @param {object} device - Prisma Device model record.
   * @returns {Promise<void>}
   */
  async checkAndAutoCreateJob(device) {
    if (!device || device.fillLevel < 80) return;

    try {
      // Check if there is already an active job open for this device to prevent duplicates
      const existingJob = await prisma.collectionJob.findFirst({
        where: {
          deviceId: device.id,
          status: { in: ['Pending', 'In Progress'] }
        }
      });

      if (!existingJob) {
        // If >= 95%, mark as Urgent; otherwise High priority
        const priority = device.fillLevel >= 95 ? 'Urgent' : 'High';
        await prisma.collectionJob.create({
          data: {
            deviceId: device.id,
            priority,
            status: 'Pending',
            collectorId: null, // Left unassigned for manager dispatch
          }
        });

        // Emit an active Alert so the dashboard bell icon lights up
        await prisma.alert.create({
          data: {
            deviceId: device.id,
            severity: device.fillLevel >= 95 ? 'CRITICAL' : 'WARNING',
            title: `Capacity Alert: ${device.customBinId}`,
            description: `Bin at ${device.location || 'College of Science'} reached ${device.fillLevel}% capacity. Collection job auto-created.`,
            status: 'Active',
          }
        });
      }
    } catch (err) {
      console.error('Error auto-creating collection job on threshold:', err);
    }
  }

  /**
   * Updates device specifications (e.g. location, facility assignment, status).
   * 
   * @param {string} id - Device UUID or customBinId (e.g. 'BIN-001').
   * @param {object} data - Fields to update.
   * @returns {Promise<object>} Updated Device record.
   */
  async updateDevice(id, data) {
    const device = await prisma.device.findFirst({
      where: {
        OR: [
          { customBinId: id },
          { id }
        ]
      },
    });
    if (!device) {
      throw new AppError('Device not found', 404, 'NOT_FOUND');
    }
    const updated = await prisma.device.update({
      where: { id: device.id },
      data,
    });
    // Check threshold in case fillLevel was manually modified
    if (updated.fillLevel >= 80) {
      await this.checkAndAutoCreateJob(updated);
    }
    return updated;
  }

  /**
   * Merges system events and waste sorting events into a unified, chronologically sorted timeline.
   * 
   * @param {string} id - customBinId of the device.
   * @param {number} [limit=100] - Maximum events to retrieve.
   * @returns {Promise<Array<object>>} Formatted timeline items.
   */
  async getDeviceEvents(id, limit = 100) {
    const [systemEvents, sortingEvents] = await Promise.all([
      prisma.deviceEvent.findMany({
        where: { device: { customBinId: id } },
        orderBy: { createdAt: 'desc' },
        take: limit
      }),
      prisma.processedItem.findMany({
        where: { device: { customBinId: id } },
        orderBy: { createdAt: 'desc' },
        take: limit
      })
    ]);

    // Format hardware / power / network events
    const formattedSystemEvents = systemEvents.map(e => ({
      id: e.id,
      type: e.eventType,
      time: new Date(e.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      desc: e.description,
      color: e.severity === 'CRITICAL' ? 'text-[#ba1a1a]' : e.severity === 'WARNING' ? 'text-[#f59e0b]' : 'text-[#3b82f6]',
      isSortingEvent: false,
      timestamp: new Date(e.createdAt).getTime()
    }));

    // Format vision AI sorting events
    const formattedSortingEvents = sortingEvents.map(e => ({
      id: e.id,
      type: 'SORTING EVENT',
      time: new Date(e.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      desc: `Detected: ${e.category}. Action: ${e.actionTaken}.`,
      color: 'text-[#10b981]',
      isSortingEvent: true,
      timestamp: new Date(e.createdAt).getTime()
    }));

    // Interleave and sort descending by timestamp
    return [...formattedSystemEvents, ...formattedSortingEvents]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /**
   * Primary Telemetry Ingestion Gateway
   * Ingests hardware fill readings and vision classification events.
   * Uploads camera photos to Supabase Storage and updates the Device record.
   * 
   * @param {object} body - Telemetry payload sent by Python ML server.
   * @returns {Promise<object>} Upserted Device record.
   */
  async saveTelemetry(body) {
    const { customBinId, location, fillLevel, fillLevelGlass, fillLevelMetal, fillLevelPaper, fillLevelRejected, lastSortedItem, confidence, status: itemStatus, imageBase64 } = body;
    
    if (!customBinId) {
      throw new AppError('customBinId is required', 400, 'VALIDATION_FAILED');
    }

    // ── 1. Upsert Device Record ───────────────────────────────────────────────
    const updatedBin = await prisma.device.upsert({
      where: { customBinId },
      update: {
        fillLevel,
        ...(fillLevelGlass !== undefined ? { fillLevelGlass } : {}),
        ...(fillLevelMetal !== undefined ? { fillLevelMetal } : {}),
        ...(fillLevelPaper !== undefined ? { fillLevelPaper } : {}),
        ...(fillLevelRejected !== undefined ? { fillLevelRejected } : {}),
        lastSortedItem,
        status: fillLevel >= 95 ? "Full" : "Active"
      },
      create: {
        customBinId,
        location: location || "College of Science",
        fillLevel: fillLevel || 0,
        fillLevelGlass: fillLevelGlass || 0,
        fillLevelMetal: fillLevelMetal || 0,
        fillLevelPaper: fillLevelPaper || 0,
        fillLevelRejected: fillLevelRejected || 0,
        lastSortedItem,
        status: fillLevel >= 95 ? "Full" : "Active"
      }
    });

    // Evaluate capacity thresholds
    await this.checkAndAutoCreateJob(updatedBin);

    let imageUrl = null;
    
    // ── 2. Handle Camera Image Upload to Supabase Storage ─────────────────────
    if (imageBase64) {
      try {
        const buffer = Buffer.from(imageBase64, 'base64');
        const fileName = `${customBinId}_${Date.now()}.jpg`;
        
        // Upload binary buffer to the 'bin_captures' Supabase Storage bucket
        const { data: uploadData, error: uploadError } = await supabase.storage
          .from('bin_captures')
          .upload(fileName, buffer, {
            contentType: 'image/jpeg',
            cacheControl: '3600',
            upsert: false
          });
          
        if (uploadError) {
          console.error("Supabase upload error:", uploadError);
        } else {
          // Retrieve public CDN URL for dashboard display
          const { data: publicUrlData } = supabase.storage.from('bin_captures').getPublicUrl(fileName);
          imageUrl = publicUrlData.publicUrl;
        }
      } catch (err) {
        console.error("Error processing image upload:", err);
      }
    }

    // ── 3. Record Sorting Event & Device Log ─────────────────────────────────
    if (lastSortedItem) {
      const isRejected = lastSortedItem.toLowerCase().includes("reject") || itemStatus === "Rejected";
      await prisma.processedItem.create({
        data: {
          deviceId: updatedBin.id,
          category: lastSortedItem,
          status: isRejected ? "Rejected" : "Sorted",
          rejectionReason: isRejected ? "Unrecognized item" : null,
          confidence: confidence || 95.0,
          actionTaken: isRejected ? "Sent to manual review" : "Sorted into correct bin",
          imageUrl: imageUrl
        }
      });
      
      await prisma.deviceEvent.create({
        data: {
          deviceId: updatedBin.id,
          eventType: "ITEM_SORTED",
          description: `Sorted item: ${lastSortedItem} (${(confidence || 95.0).toFixed(1)}% confidence)`,
          severity: "INFO"
        }
      });
    }

    return updatedBin;
  }
}

module.exports = new DeviceService();
