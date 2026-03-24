const mongoose = require('mongoose');

const transportRouteSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  school: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'School',
    required: true,
  },
  stops: [{
    type: String,
    required: true,
  }],
  defaultFee: {
    type: Number,
    default: 0,
  },
}, { timestamps: true });

module.exports = mongoose.model('TransportRoute', transportRouteSchema);
