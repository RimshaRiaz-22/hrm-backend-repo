function parsePagination(query = {}, options = {}) {
  const defaultPage = options.defaultPage || 1;
  const defaultLimit = options.defaultLimit || 10;
  const maxLimit = options.maxLimit || 100;

  const page = Math.max(Number.parseInt(query.page, 10) || defaultPage, 1);
  const limit = Math.min(
    Math.max(Number.parseInt(query.limit, 10) || defaultLimit, 1),
    maxLimit
  );
  const offset = (page - 1) * limit;

  return {
    page,
    limit,
    offset,
  };
}

function buildPaginationMeta({ page, limit, total }) {
  const safeTotal = Number(total) || 0;
  const totalPages = Math.max(Math.ceil(safeTotal / limit), 1);

  return {
    page,
    limit,
    total: safeTotal,
    total_pages: totalPages,
    has_next_page: page < totalPages,
    has_prev_page: page > 1,
  };
}

module.exports = {
  parsePagination,
  buildPaginationMeta,
};
