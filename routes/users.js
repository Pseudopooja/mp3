var User = require('../models/user.js');
var Task = require('../models/task.js');
var helpers = require('./helpers.js');

var ApiError = helpers.ApiError;

// Check the body of POST/PUT /users and return the fields to save.
function readUserBody(body) {
    if (typeof body.name !== 'string' || body.name.trim() === '') {
        throw new ApiError(400, 'A user needs a name');
    }
    if (typeof body.email !== 'string' || body.email.trim() === '') {
        throw new ApiError(400, 'A user needs an email');
    }

    var pendingTasks = body.pendingTasks;
    if (pendingTasks === undefined || pendingTasks === null) {
        pendingTasks = [];
    }
    if (!Array.isArray(pendingTasks)) {
        throw new ApiError(400, 'pendingTasks must be a list of task ids');
    }
    pendingTasks.forEach(function (id) {
        if (!helpers.isValidId(id)) {
            throw new ApiError(400, 'pendingTasks contains an invalid task id');
        }
    });

    return {
        name: body.name,
        email: body.email,
        pendingTasks: Array.from(new Set(pendingTasks)) // drop duplicate ids
    };
}

async function checkEmailIsFree(email, ownUserId) {
    var filter = { email: email };
    if (ownUserId) {
        filter._id = { $ne: ownUserId };
    }
    if (await User.exists(filter)) {
        throw new ApiError(400, 'A user with that email already exists');
    }
}

// Every id must be an existing task (404) that is not completed (400).
async function checkPendingTasks(taskIds) {
    var tasks = await Task.find({ _id: { $in: taskIds } });
    if (tasks.length !== taskIds.length) {
        throw new ApiError(404, 'A task in pendingTasks does not exist');
    }
    if (tasks.some(function (task) { return task.completed; })) {
        throw new ApiError(400, 'A completed task cannot be in pendingTasks');
    }
}

// After a user is saved, make the tasks agree with user.pendingTasks and user.name.
async function syncTasksWithUser(user) {
    var userId = user._id.toString();
    var taskIds = user.pendingTasks;

    // Pending tasks of this user that are no longer listed become unassigned.
    await Task.updateMany(
        { assignedUser: userId, completed: false, _id: { $nin: taskIds } },
        { assignedUser: '', assignedUserName: 'unassigned' }
    );
    // Listed tasks that belonged to someone else are taken off that user's list.
    await User.updateMany(
        { _id: { $ne: user._id }, pendingTasks: { $in: taskIds } },
        { $pull: { pendingTasks: { $in: taskIds } } }
    );
    await Task.updateMany(
        { _id: { $in: taskIds } },
        { assignedUser: userId, assignedUserName: user.name }
    );
    // Keeps assignedUserName right on all of the user's tasks (completed too) after a rename.
    await Task.updateMany({ assignedUser: userId }, { assignedUserName: user.name });
}

module.exports = function (router) {

    var usersRoute = router.route('/users');
    var userRoute = router.route('/users/:id');

    usersRoute.get(async function (req, res) {
        try {
            var result = await helpers.buildListQuery(User, req.query, 0);
            helpers.sendOk(res, 200, 'OK', result);
        } catch (err) {
            helpers.handleError(res, err);
        }
    });

    usersRoute.post(async function (req, res) {
        try {
            var fields = readUserBody(req.body || {});
            await checkEmailIsFree(fields.email);
            await checkPendingTasks(fields.pendingTasks);

            var user = await User.create(fields);
            await syncTasksWithUser(user);
            helpers.sendOk(res, 201, 'User created', user);
        } catch (err) {
            helpers.handleError(res, err);
        }
    });

    userRoute.get(async function (req, res) {
        try {
            var select = helpers.parseSelect(req.query);
            var user = await helpers.findByIdOr404(User, req.params.id, select, 'User not found');
            helpers.sendOk(res, 200, 'OK', user);
        } catch (err) {
            helpers.handleError(res, err);
        }
    });

    // PUT replaces the user; it never creates one (404 for unknown ids).
    userRoute.put(async function (req, res) {
        try {
            var user = await helpers.findByIdOr404(User, req.params.id, undefined, 'User not found');
            var fields = readUserBody(req.body || {});
            await checkEmailIsFree(fields.email, user._id);
            await checkPendingTasks(fields.pendingTasks);

            user.name = fields.name;
            user.email = fields.email;
            user.pendingTasks = fields.pendingTasks;
            await user.save();
            await syncTasksWithUser(user);
            helpers.sendOk(res, 200, 'User updated', user);
        } catch (err) {
            helpers.handleError(res, err);
        }
    });

    userRoute.delete(async function (req, res) {
        try {
            var user = await helpers.findByIdOr404(User, req.params.id, undefined, 'User not found');
            // Unassign all of the user's tasks, completed ones included.
            await Task.updateMany(
                { assignedUser: user._id.toString() },
                { assignedUser: '', assignedUserName: 'unassigned' }
            );
            await user.deleteOne();
            helpers.sendOk(res, 200, 'User deleted', user);
        } catch (err) {
            helpers.handleError(res, err);
        }
    });

    return router;
};
