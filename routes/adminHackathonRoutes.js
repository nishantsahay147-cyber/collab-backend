const express = require('express')
const router = express.Router()
const { requireRole } = require('../middleware/rbac')
const {
  createHackathon,
  listHackathons,
  getHackathonDetails,
  updateHackathon,
  approveHackathon,
  archiveHackathon,
  restoreHackathon,
  permanentlyDeleteHackathon,
  listHackathonRegistrations,
  createHackathonRegistration,
  createHackathonTeam,
  getHackathonRegistrationDetails,
  updateHackathonRegistrationStatus,
  updateHackathonTeam,
  deleteHackathonTeam,
  createHackathonStage,
  listHackathonStages,
  updateHackathonStage,
  deleteHackathonStage,
  createJudgingCriteria,
  listJudgingCriteria,
  updateJudgingCriteria,
  deleteJudgingCriteria,
  createJudgeReview,
  listStageEvaluations,
  getTeamEvaluation,
  updateJudgeReview,
  getHackathonLeaderboard,
  getHackathonReport,
  getHackathonExportData,
  downloadHackathonCsv,
  downloadHackathonPdf,
  submitHackathonProject,
  listHackathonSubmissions,
  updateHackathonSubmissionStatus,
  createHackathonAnnouncement,
  listHackathonAnnouncements,
  updateHackathonAnnouncement,
  deleteHackathonAnnouncement
} = require('../controllers/adminHackathonController')

router.get('/', requireRole('admin'), listHackathons)
router.post('/', requireRole('admin'), createHackathon)
router.get('/:id', requireRole('admin'), getHackathonDetails)
router.patch('/:id', requireRole('admin'), updateHackathon)
router.patch('/:id/approve', requireRole('admin'), approveHackathon)
router.delete('/:id', requireRole('admin'), archiveHackathon)
router.patch('/:id/restore', requireRole('admin'), restoreHackathon)
router.delete('/:id/permanent', requireRole('admin'), permanentlyDeleteHackathon)
router.get('/:id/registrations', requireRole('admin'), listHackathonRegistrations)
router.post('/:id/registrations', requireRole('admin'), createHackathonRegistration)
router.post('/:id/teams', requireRole('admin'), createHackathonTeam)
router.get('/:id/registrations/:registrationId', requireRole('admin'), getHackathonRegistrationDetails)
router.patch('/:id/registrations/:registrationId/status', requireRole('admin'), updateHackathonRegistrationStatus)
router.patch('/:id/registrations/:registrationId', requireRole('admin'), updateHackathonTeam)
router.delete('/:id/registrations/:registrationId', requireRole('admin'), deleteHackathonTeam)
router.get('/:id/stages', requireRole('admin'), listHackathonStages)
router.post('/:id/stages', requireRole('admin'), createHackathonStage)
router.patch('/:id/stages/:stageId', requireRole('admin'), updateHackathonStage)
router.delete('/:id/stages/:stageId', requireRole('admin'), deleteHackathonStage)
router.get('/:id/stages/:stageId/criteria', requireRole('admin'), listJudgingCriteria)
router.post('/:id/stages/:stageId/criteria', requireRole('admin'), createJudgingCriteria)
router.patch('/:id/stages/:stageId/criteria/:criteriaId', requireRole('admin'), updateJudgingCriteria)
router.delete('/:id/stages/:stageId/criteria/:criteriaId', requireRole('admin'), deleteJudgingCriteria)
router.post('/:id/stages/:stageId/registrations/:registrationId/evaluations', requireRole('admin'), createJudgeReview)
router.get('/:id/stages/:stageId/evaluations', requireRole('admin'), listStageEvaluations)
router.get('/:id/stages/:stageId/registrations/:registrationId/evaluation', requireRole('admin'), getTeamEvaluation)
router.patch('/:id/stages/:stageId/evaluations/:reviewId', requireRole('admin'), updateJudgeReview)
router.get('/:id/leaderboard', requireRole('admin'), getHackathonLeaderboard)
router.get('/:id/report', requireRole('admin'), getHackathonReport)
router.get('/:id/export-data', requireRole('admin'), getHackathonExportData)
router.get('/:id/export.csv', requireRole('admin'), downloadHackathonCsv)
router.get('/:id/export.pdf', requireRole('admin'), downloadHackathonPdf)
router.post('/:id/registrations/:registrationId/submission', requireRole('admin'), submitHackathonProject)
router.get('/:id/submissions', requireRole('admin'), listHackathonSubmissions)
router.patch('/:id/submissions/:submissionId/status', requireRole('admin'), updateHackathonSubmissionStatus)
router.get('/:id/announcements', requireRole('admin'), listHackathonAnnouncements)
router.post('/:id/announcements', requireRole('admin'), createHackathonAnnouncement)
router.patch('/:id/announcements/:announcementId', requireRole('admin'), updateHackathonAnnouncement)
router.delete('/:id/announcements/:announcementId', requireRole('admin'), deleteHackathonAnnouncement)

module.exports = router
