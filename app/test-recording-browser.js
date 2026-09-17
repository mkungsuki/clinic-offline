'use strict';
module.exports=async function(context){
  await require('./test-vitals-browser')(context);
  await require('./test-dispensing-dose-units-browser')(context);
};
