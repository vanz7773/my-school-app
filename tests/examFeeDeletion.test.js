const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Campaign = require('../models/ExamFeeCampaign');
const Charge = require('../models/ExamFeeCharge');
const Payment = require('../models/ExamFeePayment');
const Remittance = require('../models/ExamFeeRemittance');
const Assignment = require('../models/ExamFeeCollectorAssignment');
const core = require('../services/examFees/core');
const { remove } = require('../services/examFees/campaigns');
const id = () => new mongoose.Types.ObjectId();
function setup(t, history) {
 const user = { role: 'admin', school: id(), _id: id() }, campaignId = String(id()), session = {};
 const scoped = filter => { assert.equal(filter.school, user.school); };
 t.mock.method(core, 'transaction', async (actor, fn) => { assert.equal(actor, user); return fn(session); });
 t.mock.method(Campaign, 'findOne', filter => { scoped(filter); return { session: async s => { assert.equal(s,session); return { _id: campaignId, name:'Mock 1', academicYear:'2026-2027', termName:'Term 1', status:'active', classFees:[] }; } }; });
 for (const [model, key] of [[Payment,'payment'],[Remittance,'remittance'],[Charge,'charge']]) t.mock.method(model,'exists',filter => { scoped(filter); assert.equal(filter.campaign,campaignId); return { session: async s => { assert.equal(s,session); return history === key; } }; });
 const deleted=[];
 for (const model of [Charge, Assignment, Campaign]) t.mock.method(model,model === Campaign?'deleteOne':'deleteMany',async(filter,options)=>{scoped(filter); assert.equal(options.session,session); deleted.push(model.modelName); return {deletedCount:1};});
 const audit=t.mock.method(core,'audit',async()=>{});
 return {user,campaignId,session,deleted,audit};
}
test('unused activated duplicate is removed with unpaid charges, assignments and an audit snapshot',async t=>{
 const f=setup(t);
 assert.deepEqual(await remove(f.user,f.campaignId,{reason:'Duplicate entry'}),{deletedCampaignId:String(f.campaignId)});
 assert.deepEqual(f.deleted,['ExamFeeCharge','ExamFeeCollectorAssignment','ExamFeeCampaign']);
 const args=f.audit.mock.calls[0].arguments;
 assert.equal(args[1],'campaign.deleted'); assert.equal(args[4].reason,'Duplicate entry'); assert.equal(args[4].name,'Mock 1');
});
for (const history of ['payment','remittance','charge']) test(`${history} history blocks deletion before any destructive operation`,async t=>{
 const f=setup(t,history);
 await assert.rejects(remove(f.user,f.campaignId,{reason:'Duplicate'}),error=>error.status===409);
 assert.deepEqual(f.deleted,[]); assert.equal(f.audit.mock.callCount(),0);
});
test('teachers, missing reasons and cross-school missing campaigns cannot delete',async t=>{
 const f=setup(t);
 await assert.rejects(remove({...f.user,role:'teacher'},f.campaignId,{reason:'Duplicate'}),e=>e.status===403);
 await assert.rejects(remove(f.user,f.campaignId,{reason:''}),e=>e.status===400);
 t.mock.method(Campaign,'findOne',filter=>{assert.equal(filter.school,f.user.school); return {session:async()=>null};});
 await assert.rejects(remove(f.user,f.campaignId,{reason:'Duplicate'}),e=>e.status===404);
 assert.deepEqual(f.deleted,[]);
});
