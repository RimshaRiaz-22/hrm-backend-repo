const payElementService = require('./payElement.service');

module.exports = {
  create: payElementService.createAllowance,
  list: payElementService.listAllowances,
  update: payElementService.updateAllowance,
  remove: payElementService.deleteAllowance,
};
