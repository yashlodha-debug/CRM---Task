/**
 * Dropdown options service - lets Master manage the values behind every
 * dropdown (Assigned, Task, Related To, Exis Data, Status, Dashboard
 * Status) without ever touching the database directly.
 *
 * Note: these are plain reference values, not foreign keys - a task
 * stores the chosen text directly, so editing/removing an option here
 * never breaks or changes any existing task's data.
 */
const { query } = require('../db/pool');

async function listAll() {
  const { rows } = await query(
    `select * from dropdown_options order by field_name asc, sort_order asc, value asc`
  );
  return rows;
}

async function listByField(fieldName) {
  const { rows } = await query(
    `select * from dropdown_options where field_name = $1 order by sort_order asc, value asc`,
    [fieldName]
  );
  return rows;
}

async function createOption({ fieldName, value, sortOrder }) {
  if (!fieldName || !value) {
    throw Object.assign(new Error('fieldName and value are required.'), { statusCode: 400 });
  }
  const { rows } = await query(
    `insert into dropdown_options (field_name, value, sort_order, is_active)
     values ($1, $2, $3, true)
     on conflict (field_name, value) do update set is_active = true, sort_order = excluded.sort_order
     returning *`,
    [fieldName, value, sortOrder ?? 0]
  );
  return rows[0];
}

async function updateOption(id, { value, sortOrder, isActive }) {
  const { rows } = await query(
    `update dropdown_options
     set value = coalesce($1, value),
         sort_order = coalesce($2, sort_order),
         is_active = coalesce($3, is_active)
     where id = $4
     returning *`,
    [value ?? null, sortOrder ?? null, isActive ?? null, id]
  );
  if (rows.length === 0) {
    throw Object.assign(new Error('Dropdown option not found.'), { statusCode: 404 });
  }
  return rows[0];
}

async function deleteOption(id) {
  const { rows } = await query(`delete from dropdown_options where id = $1 returning id`, [id]);
  if (rows.length === 0) {
    throw Object.assign(new Error('Dropdown option not found.'), { statusCode: 404 });
  }
  return { success: true };
}

module.exports = { listAll, listByField, createOption, updateOption, deleteOption };
