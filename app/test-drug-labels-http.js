'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
module.exports=async function({req,front,doctor,admin,check}){
 const before=await req(front,'GET','/print/labels/UNKNOWN');assert.equal(before.status,404);assert.match(before.text,/ยังไม่ได้เปิด/);check('labels off by default, direct URL denied');
 assert.equal((await req(front,'POST','/api/settings',{drug_label_enabled:'1'})).status,403);
 assert.equal((await req(admin,'POST','/api/settings',{drug_label_enabled:'1',drug_label_width:'19'})).status,400);
 assert.notEqual((await req(admin,'GET','/api/settings')).data.drug_label_enabled,'1');check('labels roles and settings validation before write');
 await req(admin,'POST','/api/settings',{drug_label_enabled:'1',drug_label_layout:'a4-2x5'});
 const item=(await req(front,'POST','/api/drugs',{name:'ฉลากสังเคราะห์',unit:'เม็ด',price:1})).data;
 await req(front,'POST',`/api/drugs/${item.id}/receive`,{qty:100,expiry_date:'2028-12-31',reason:'สังเคราะห์',op_id:crypto.randomUUID()});
 const service=(await req(doctor,'GET','/api/items/search?q=')).data.find(i=>i.type==='service');
 async function receipt(lines){if(!lines.length)lines=[{type:'service',ref_id:service.id,qty:1}];const p=(await req(front,'POST','/api/patients',{first_name:'ฉลากสังเคราะห์',sex:'F',op_id:crypto.randomUUID()})).data;const v=(await req(front,'POST','/api/visits',{hn:p.hn,op_id:crypto.randomUUID()})).data;await req(doctor,'POST',`/api/visits/${v.id}/call`);const finish=await req(doctor,'POST',`/api/visits/${v.id}/finish-exam`,{note:{cc:'สังเคราะห์'},lines,base_version_id:null});assert.equal(finish.status,200);const paid=await req(front,'POST',`/api/visits/${v.id}/pay`,{order_version_id:finish.data.order.id,pay_method:'cash',op_id:crypto.randomUUID()});assert.equal(paid.status,201);return paid.data.receiptNo;}
 const no=await receipt([{type:'drug',ref_id:item.id,qty:1,instructions:'คำสั่งสังเคราะห์เดิม'},{type:'drug',ref_id:item.id,qty:2,instructions:'คำสั่งสังเคราะห์ที่สอง'}]);
 let response=await req(front,'GET','/print/labels/'+no);assert.equal(response.status,200);assert(response.text.includes('คำสั่งสังเคราะห์เดิม'));assert(response.text.includes('data-can-print="1"'));check('labels render immutable receipt text');
 response=await req(doctor,'GET','/print/labels/'+no);assert.equal(response.status,200);assert(response.text.includes('data-can-print="0"'));assert(response.text.includes('ให้หน้าร้านพิมพ์ฉลากยา'));check('doctor can view but print button disabled');
 response=await req(front,'GET','/print/labels/'+no+'?items=1&start=6');assert.equal(response.status,200);assert(response.text.includes('id="selectedItems" value="1"'));assert.equal((await req(front,'GET','/print/labels/'+no+'?start=11')).status,400);check('labels selected item, start slot bounds');
 assert.equal((await req(front,'GET','/print/labels/'+await receipt([]))).status,409);check('labels no medicine denied');
 assert.equal((await req(front,'GET','/print/labels/'+await receipt([{type:'drug',ref_id:item.id,qty:1,instructions:''}]))).status,409);check('labels missing instructions denied');
 await req(front,'POST',`/api/receipts/${no}/refund`,{reason:'สังเคราะห์',returned_stock:false,op_id:crypto.randomUUID()});assert.equal((await req(front,'GET','/print/labels/'+no)).status,409);check('labels void receipt denied');
 assert((await req(admin,'GET','/print/sample/labels?layout=roll&width=80&height=50')).text.includes('size:80mm 50mm'));check('labels synthetic roll sample');
 await req(admin,'POST','/api/settings',{drug_label_enabled:'0'});
};
