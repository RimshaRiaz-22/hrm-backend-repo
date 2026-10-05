const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

function parseBooleanQuery(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return null;
}

function parsePagination(query = {}) {
  const pageRaw = query.page;
  const limitRaw = query.limit;

  const page = pageRaw === undefined ? DEFAULT_PAGE : Number(pageRaw);
  const limit = limitRaw === undefined ? DEFAULT_LIMIT : Number(limitRaw);

  if (!Number.isInteger(page) || page <= 0) {
    return { error: 'page must be a positive integer.' };
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    return { error: 'limit must be a positive integer.' };
  }

  if (limit > MAX_LIMIT) {
    return { error: `limit must be less than or equal to ${MAX_LIMIT}.` };
  }

  return {
    page,
    limit,
    offset: (page - 1) * limit,
  };
}

function buildPaginationMeta(totalItems, page, limit) {
  const total = Number(totalItems) || 0;
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

  return {
    page,
    limit,
    total_items: total,
    total,
    total_pages: totalPages,
    has_next_page: page < totalPages,
    has_prev_page: page > 1 && totalPages > 0,
  };
}

/** Resolves page/limit or full list when `no_pagination=true`. */
function parseListPagination(query = {}) {
  const noPagination = parseBooleanQuery(query.no_pagination, false);
  if (noPagination === null) {
    return { error: 'no_pagination must be true or false.' };
  }
  if (noPagination) {
    return { noPagination: true, pagination: null };
  }

  const pagination = parsePagination(query);
  if (pagination.error) {
    return { error: pagination.error };
  }

  return { noPagination: false, pagination };
}

function buildListPaginationMeta(totalItems, listPagination) {
  const total = Number(totalItems) || 0;
  if (listPagination.noPagination) {
    return buildPaginationMeta(total, 1, total > 0 ? total : 1);
  }
  return buildPaginationMeta(total, listPagination.pagination.page, listPagination.pagination.limit);
}

module.exports = {
  parseBooleanQuery,
  parsePagination,
  parseListPagination,
  buildPaginationMeta,
  buildListPaginationMeta,
};
