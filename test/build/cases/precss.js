var path = require('path');
GLOBAL.APP_ROOT = path.resolve(__dirname, '../example');
console.log(GLOBAL.APP_ROOT);
require('../../precss');
console.log(GLOBAL.APP_ROOT);
