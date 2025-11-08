const mongoose = require('mongoose');

const CountrySchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please add country name'],
  },
  code: {
    type: String,
    required: [true, 'Please add country code'],
  },
  state: [
    {
      name: {
        type: String,
      },
      code: {
        type: String,
      },
    },
  ],

  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('Country', CountrySchema);
