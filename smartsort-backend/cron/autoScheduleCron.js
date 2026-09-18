/**
 * ============================================================================
 * Automated Job Scheduler Cron Worker (cron/autoScheduleCron.js)
 * ============================================================================
 * Recurring background task that inspects current smart bin fill levels across
 * all facilities and automatically dispatches pickup requests.
 *
 * Execution Interval: Every minute ('* * * * *')
 * Logic:
 *  1. Scans all active devices for fill levels exceeding the 80% capacity threshold.
 *  2. Creates a 'Pending' CollectionJob if none is currently active for that bin.
 *  3. Generates high-visibility Alert notifications (CRITICAL if >= 95%, WARNING if >= 80%)
 *     so facility managers receive real-time dashboard notifications.
 */

const cron = require('node-cron');
const jobService = require('../services/jobService');
const { prisma } = require('../lib/prisma');
const logger = require('../utils/logger');

// Run every minute ('* * * * *')
cron.schedule('* * * * *', async () => {
  try {
    // 80% threshold, autoAssign: false (leaves jobs pending in the queue for manager assignment)
    const result = await jobService.autoScheduleJobs({
      threshold: 80,
      autoAssign: false,
    });
    
    if (result.createdCount > 0) {
      logger.info(result.message);

      // Associate alerts with each created job's underlying device record
      for (const createdJob of result.createdJobs) {
        const dbJob = await prisma.collectionJob.findUnique({
          where: { id: createdJob.id },
          select: { deviceId: true },
        });

        if (dbJob) {
          const severity = createdJob.urgency === 'Critical' ? 'CRITICAL' : createdJob.urgency === 'High' ? 'WARNING' : 'INFO';
          await prisma.alert.create({
            data: {
              deviceId: dbJob.deviceId,
              severity,
              title: `Auto-scheduled: ${createdJob.location}`,
              description: `Bin at ${createdJob.location} reached ${createdJob.fill}% capacity. A collection job has been automatically created.`,
              status: 'Active',
            },
          });
        }
      }

      logger.info(`Created ${result.createdCount} alert(s) for auto-scheduled jobs.`);
    }
  } catch (error) {
    logger.error(`Error running auto schedule cron job: ${error.message}`);
  }
});
