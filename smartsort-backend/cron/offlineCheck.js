/**
 * ============================================================================
 * Hardware Heartbeat & Offline Detection Cron Worker (cron/offlineCheck.js)
 * ============================================================================
 * Recurring background task that monitors the connectivity status of smart bins
 * in the field.
 *
 * Execution Interval: Every minute ('* * * * *')
 * Logic:
 *  1. Identifies devices whose `updatedAt` timestamp is older than 5 minutes.
 *  2. Marks active devices as 'Offline' in the PostgreSQL database.
 *  3. Generates a 'CRITICAL' Alert notifying facility engineers that physical
 *     hardware inspection (power supply, Wi-Fi connectivity) is required.
 */

const cron = require('node-cron');
const { prisma } = require('../lib/prisma');
const logger = require('../utils/logger');

// Run every minute ('* * * * *')
cron.schedule('* * * * *', async () => {
  try {
    // 5 minutes heartbeat cutoff window
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    // Find all devices that haven't sent telemetry in 5 minutes and aren't already marked Offline
    const offlineDevices = await prisma.device.findMany({
      where: {
        updatedAt: {
          lt: fiveMinutesAgo,
        },
        status: {
          not: 'Offline',
        },
      },
    });

    if (offlineDevices.length > 0) {
      logger.info(`Found ${offlineDevices.length} offline devices. Updating status and flagging admin.`);

      // Prepare critical alerts for the admin dashboard
      const alertsData = offlineDevices.map((device) => ({
        deviceId: device.id,
        severity: 'CRITICAL',
        title: 'Device Offline',
        description: `Device ${device.customBinId} missed telemetry heartbeats for over 5 minutes. Physical inspection required.`,
        status: 'Active',
      }));

      // Batch update device statuses to 'Offline'
      await prisma.device.updateMany({
        where: {
          id: {
            in: offlineDevices.map(d => d.id),
          },
        },
        data: {
          status: 'Offline',
        },
      });

      // Batch create alert records in database
      await prisma.alert.createMany({
        data: alertsData,
      });
      
      logger.info(`Offline devices updated and admin flagged successfully.`);
    }
  } catch (error) {
    logger.error(`Error running offline check cron job: ${error.message}`);
  }
});
