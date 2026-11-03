/*
 * Small helpers shared by users.js and tasks.js.
 */

// An error caused by the client's request; routes throw it and handleError
// turns it into a { message, data: null } response with the given status.
class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function sendOk(res, status, message, data) {
    res.status(status).json({ message: message, data: data });
}

function sendError(res, status, message) {
    res.status(status).json({ message: message, data: null });
}

// Turn any error into a response without leaking Mongoose/MongoDB details.
function handleError(res, err) {
    if (err instanceof ApiError) {
        return sendError(res, err.status, err.message);
    }
    if (err && err.code === 11000) {
        return sendError(res, 400, 'A user with that email already exists');
    }
    // Bad values inside a query (e.g. where={"_id": "abc"}) or a rejected filter/projection
    if (err && (err.name === 'CastError' || err.name === 'ValidationError' || err.name === 'MongoServerError')) {
        return sendError(res, 400, 'The request contains an invalid value');
    }
    console.error(err);
    sendError(res, 500, 'Something went wrong on the server');
}

// A Mongo ObjectId written as a 24-character hex string.
function isValidId(id) {
    return typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id);
}

// Look up a document by the :id in the URL. Malformed and unknown ids are both 404.
async function findByIdOr404(Model, id, select, notFoundMessage) {
    if (!isValidId(id)) {
        throw new ApiError(404, notFoundMessage);
    }
    var query = Model.findById(id);
    if (select !== undefined) {
        query.select(select);
    }
    var doc = await query;
    if (!doc) {
        throw new ApiError(404, notFoundMessage);
    }
    return doc;
}

// ---- Query string parameters ----

function parseJsonParam(query, name) {
    var raw = query[name];
    if (raw === undefined) {
        return undefined;
    }
    if (typeof raw !== 'string') {
        throw new ApiError(400, 'Query parameter "' + name + '" must be given once');
    }
    try {
        return JSON.parse(raw);
    } catch (e) {
        throw new ApiError(400, 'Query parameter "' + name + '" must be valid JSON');
    }
}

function parseObjectParam(query, name) {
    var value = parseJsonParam(query, name);
    if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
        throw new ApiError(400, 'Query parameter "' + name + '" must be a JSON object');
    }
    return value;
}

function parseCountingParam(query, name) {
    var value = parseJsonParam(query, name);
    if (value !== undefined && !(Number.isInteger(value) && value >= 0)) {
        throw new ApiError(400, 'Query parameter "' + name + '" must be a non-negative integer');
    }
    return value;
}

// select is the only query parameter used by GET /users/:id and GET /tasks/:id.
function parseSelect(query) {
    return parseObjectParam(query, 'select');
}

// Build the Mongoose query for GET /users or GET /tasks from where, sort,
// select, skip, limit and count. defaultLimit is used when no limit is given.
function buildListQuery(Model, query, defaultLimit) {
    var where = parseObjectParam(query, 'where') || {};
    var sort = parseObjectParam(query, 'sort');
    var select = parseObjectParam(query, 'select');
    var skip = parseCountingParam(query, 'skip');
    var limit = parseCountingParam(query, 'limit');
    var count = parseJsonParam(query, 'count');
    if (count !== undefined && typeof count !== 'boolean') {
        throw new ApiError(400, 'Query parameter "count" must be true or false');
    }

    var mongoQuery = count ? Model.countDocuments(where) : Model.find(where);
    if (sort !== undefined && !count) {
        mongoQuery.sort(sort);
    }
    if (select !== undefined && !count) {
        mongoQuery.select(select);
    }
    if (skip !== undefined) {
        mongoQuery.skip(skip);
    }
    if (limit !== undefined) {
        mongoQuery.limit(limit);
    } else if (defaultLimit && !count) {
        mongoQuery.limit(defaultLimit);
    }
    return mongoQuery;
}

module.exports = {
    ApiError: ApiError,
    sendOk: sendOk,
    sendError: sendError,
    handleError: handleError,
    isValidId: isValidId,
    findByIdOr404: findByIdOr404,
    parseSelect: parseSelect,
    buildListQuery: buildListQuery
};
