const payElementService = require('./payElement.service');

module.exports = {
  create: payElementService.createContribution,
  list: payElementService.listContributions,
  update: payElementService.updateContribution,
  remove: payElementService.deleteContribution,
};
