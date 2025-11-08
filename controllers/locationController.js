const asyncHandler = require('../middleware/async');
const ErrorResponse = require('../utils/errorResponse');

const addressData = require('../_data/countries+states+cities.json');

const locationJson = addressData.map((country) => ({
  countryName: country.name,
  countryId: country.id,
  latitude: country.latitude,
  longitude: country.longitude,
  value: country.name,
  label: country.name,
  states: country?.states?.map((state) => ({
    countryName: country.name,
    countryId: country.id,
    stateName: state.name,
    stateId: state.id,
    latitude: state.latitude,
    longitude: state.longitude,
    value: state.name,
    label: state.name,
    cities: state.cities.map((city) => ({
      countryName: country.name,
      countryId: country.id,
      stateName: state.name,
      stateId: state.id,
      cityName: city.name,
      cityId: city.id,
      latitude: city.latitude,
      longitude: city.longitude,
      value: city.name,
      label: city.name,
    })),
  })),
}));

// @desc   Get all location
// @route   /api/v1/location
// @access   Public
exports.getLocations = asyncHandler(async (req, res, next) => {
  ///see the route
  res.status(200).json({
    success: true,
    data: locationJson,
  });
});
