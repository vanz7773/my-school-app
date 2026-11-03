const mongoose = require('mongoose');
const ref = (model, required = true) => ({ type: mongoose.Schema.Types.ObjectId, ref: model, required });
const money = (min = 0) => ({ type: Number, required: true, min, max: 100000000000, validate: Number.isSafeInteger });
const methods = ['cash', 'mobile_money', 'bank_transfer', 'cheque'];
const examinationTypes = ['end_of_term', 'mock', 'mid_term'];
module.exports = { ref, money, methods, examinationTypes };
