const express = require('express')
const router = express.Router()
const { listEvents, getEventDetails, getEventDashboard } = require('../controllers/eventController')
const { protect } = require('../middleware/authMiddleware')

router.get('/', listEvents)
router.get('/:id/dashboard', protect, getEventDashboard)
router.get('/:id', getEventDetails)

module.exports = router
