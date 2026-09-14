const pool = require('../db');
const { USER_ROLES } = require('../constants/userRoles');
const { sendSuccess, sendError } = require('../utils/apiResponse');

exports.createNote = async (req, res) => {
  try {
    const { title, content, employee_name } = req.body;
    const { userId: user_id, role, companyId: company_id } = req.authUser;

    if (!title || !content) {
      return sendError(res, 400, 'Title and content are required');
    }

    const result = await pool.query(
      `INSERT INTO notes (company_id, employee_name, title, content, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [company_id, employee_name || null, title, content, user_id]
    );

    return sendSuccess(res, 201, 'Note created successfully', result.rows[0]);
  } catch (error) {
    console.error('Error creating note:', error);
    return sendError(res, 500, 'Internal server error');
  }
};

exports.getNotes = async (req, res) => {
  try {
    const { userId: user_id, role, companyId: company_id } = req.authUser;

    let query = `
      SELECT 
        n.*,
        COALESCE(u.full_name, '') AS created_by_name
      FROM notes n
      JOIN users u ON n.created_by = u.id
      WHERE n.company_id = $1
    `;
    const queryParams = [company_id];

    if (role === USER_ROLES.EMPLOYEE) {
      query += ` AND n.created_by = $2`;
      queryParams.push(user_id);
    } else {
      const { employee_name } = req.query;
      if (employee_name) {
        queryParams.push(`%${employee_name.toLowerCase()}%`);
        query += ` AND LOWER(n.employee_name) LIKE $${queryParams.length}`;
      }
    }

    query += ` ORDER BY n.created_at DESC`;

    const result = await pool.query(query, queryParams);

    return sendSuccess(res, 200, 'Notes retrieved successfully', result.rows);
  } catch (error) {
    console.error('Error retrieving notes:', error);
    return sendError(res, 500, 'Internal server error');
  }
};

exports.updateNote = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content, employee_name } = req.body;
    const { userId: user_id, role, companyId: company_id } = req.authUser;

    const noteResult = await pool.query(
      `SELECT * FROM notes WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );

    if (noteResult.rows.length === 0) {
      return sendError(res, 404, 'Note not found');
    }

    const note = noteResult.rows[0];

    if (role === USER_ROLES.EMPLOYEE && note.created_by !== user_id) {
      return sendError(res, 403, 'Access denied');
    }

    const result = await pool.query(
      `UPDATE notes 
       SET title = $1, content = $2, employee_name = $3, updated_at = NOW() AT TIME ZONE 'UTC'
       WHERE id = $4 AND company_id = $5
       RETURNING *`,
      [title || note.title, content || note.content, employee_name || note.employee_name, id, company_id]
    );

    return sendSuccess(res, 200, 'Note updated successfully', result.rows[0]);
  } catch (error) {
    console.error('Error updating note:', error);
    return sendError(res, 500, 'Internal server error');
  }
};

exports.deleteNote = async (req, res) => {
  try {
    const { id } = req.params;
    const { userId: user_id, role, companyId: company_id } = req.authUser;

    const noteResult = await pool.query(
      `SELECT * FROM notes WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );

    if (noteResult.rows.length === 0) {
      return sendError(res, 404, 'Note not found');
    }

    const note = noteResult.rows[0];

    if (role === USER_ROLES.EMPLOYEE && note.created_by !== user_id) {
      return sendError(res, 403, 'Access denied');
    }

    await pool.query(
      `DELETE FROM notes WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );

    return sendSuccess(res, 200, 'Note deleted successfully');
  } catch (error) {
    console.error('Error deleting note:', error);
    return sendError(res, 500, 'Internal server error');
  }
};
