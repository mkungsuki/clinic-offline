'use strict';
const fs=require('node:fs'),path=require('node:path');
module.exports=function pending(app){return fs.existsSync(path.join(app,'../update/trial-maintenance-pending.json'));};
