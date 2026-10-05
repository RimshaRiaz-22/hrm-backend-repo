const payElementService = require('./payElement.service');

module.exports = {
  create: payElementService.createDeduction,
  list: payElementService.listDeductions,
  update: payElementService.updateDeduction,
  remove: payElementService.deleteDeduction,
};
