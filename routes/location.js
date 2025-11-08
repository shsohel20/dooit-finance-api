const express = require('express');

const { getLocations } = require('../controllers/locationController');

const router = express.Router();

router.route('/').get(getLocations);

module.exports = router;
