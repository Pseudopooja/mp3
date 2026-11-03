var User = require('../models/user.js');
var Task = require('../models/task.js');
var helpers = require('./helpers.js');

var ApiError = helpers.ApiError;

// Accept a Date-like value: a number of milliseconds, a numeric string, or a date string.
function readDeadline(value) {
    if (typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value))) {
        value = Number(value);
    }
    if (typeof value !== 'number' && typeof value !== 'string') {
        throw new ApiError(400, 'A task needs a deadline');
    }
    var date = new Date(value);
    if (isNaN(date.getTime())) {
        throw new ApiError(400, 'The deadline is not a valid date');
    }
    return date;
}

// Accept true/false, or "true"/"false" from form-encoded bodies.
function readCompleted(value) {
    if (value === undefined || value === null) {
        return false;
    }
    if (value === true || value === 'true') {
        return true;
    }
    if (value === false || value === 'false') {
        return false;
    }
    throw new ApiError(400, 'completed must be true or false');
}

// Check the body of POST/PUT /tasks and return the fields to save.
// Missing optional fields get their defaults, since PUT replaces the whole task.
async function readTaskBody(body) {
    if (typeof body.name !== 'string' || body.name.trim() === '') {
        throw new ApiError(400, 'A task needs a name');
    }
    var deadline = readDeadline(body.deadline);

    var description = body.description;
    if (description === undefined || description === null) {
        description = '';
    }
    if (typeof description !== 'string') {
        throw new ApiError(400, 'description must be a string');
    }
    var completed = readCompleted(body.completed);

    var assignedUser = body.assignedUser;
    if (assignedUser === undefined || assignedUser === null) {
        assignedUser = '';
    }
    if (assignedUser !== '' && !helpers.isValidId(assignedUser)) {
        throw new ApiError(400, 'assignedUser is not a valid user id');
    }
    var assignedUserName = body.assignedUserName;
    if (assignedUserName === null || assignedUserName === '') {
        assignedUserName = undefined;
    }
    if (assignedUserName !== undefined && typeof assignedUserName !== 'string') {
        throw new ApiError(400, 'assignedUserName must be a string');
    }

    // assignedUser and assignedUserName must describe the same user.
    if (assignedUser === '') {
        if (assignedUserName !== undefined && assignedUserName !== 'unassigned') {
            throw new ApiError(400, 'assignedUserName must be "unassigned" when there is no assignedUser');
        }
        assignedUserName = 'unassigned';
    } else {
        var user = await User.findById(assignedUser);
        if (!user) {
            throw new ApiError(404, 'The assigned user does not exist');
        }
        if (assignedUserName !== undefined && assignedUserName !== user.name) {
            throw new ApiError(400, 'assignedUserName does not match the name of assignedUser');
        }
        assignedUserName = user.name;
    }

    return {
        name: body.name,
        description: description,
        deadline: deadline,
        completed: completed,
        assignedUser: assignedUser,
        assignedUserName: assignedUserName
    };
}

// After a task is saved, update pendingTasks of its previous and current user.
async function syncUsersWithTask(task, previousUserId) {
    var taskId = task._id.toString();
    if (previousUserId && previousUserId !== task.assignedUser) {
        await User.updateOne({ _id: previousUserId }, { $pull: { pendingTasks: taskId } });
    }
    if (task.assignedUser) {
        // Only pending tasks are listed; a completed task stays assigned but leaves the list.
        var change = task.completed ? { $pull: { pendingTasks: taskId } } : { $addToSet: { pendingTasks: taskId } };
        await User.updateOne({ _id: task.assignedUser }, change);
    }
}

module.exports = function (router) {

    var tasksRoute = router.route('/tasks');
    var taskRoute = router.route('/tasks/:id');

    tasksRoute.get(async function (req, res) {
        try {
            var result = await helpers.buildListQuery(Task, req.query, 100);
            helpers.sendOk(res, 200, 'OK', result);
        } catch (err) {
            helpers.handleError(res, err);
        }
    });

    tasksRoute.post(async function (req, res) {
        try {
            var fields = await readTaskBody(req.body || {});
            var task = await Task.create(fields);
            await syncUsersWithTask(task, '');
            helpers.sendOk(res, 201, 'Task created', task);
        } catch (err) {
            helpers.handleError(res, err);
        }
    });

    taskRoute.get(async function (req, res) {
        try {
            var select = helpers.parseSelect(req.query);
            var task = await helpers.findByIdOr404(Task, req.params.id, select, 'Task not found');
            helpers.sendOk(res, 200, 'OK', task);
        } catch (err) {
            helpers.handleError(res, err);
        }
    });

    // PUT replaces the task; it never creates one (404 for unknown ids).
    taskRoute.put(async function (req, res) {
        try {
            var task = await helpers.findByIdOr404(Task, req.params.id, undefined, 'Task not found');
            var fields = await readTaskBody(req.body || {});
            var previousUserId = task.assignedUser;

            task.set(fields);
            await task.save();
            await syncUsersWithTask(task, previousUserId);
            helpers.sendOk(res, 200, 'Task updated', task);
        } catch (err) {
            helpers.handleError(res, err);
        }
    });

    taskRoute.delete(async function (req, res) {
        try {
            var task = await helpers.findByIdOr404(Task, req.params.id, undefined, 'Task not found');
            await task.deleteOne();
            if (task.assignedUser) {
                await User.updateOne({ _id: task.assignedUser }, { $pull: { pendingTasks: task._id.toString() } });
            }
            res.status(204).end();
        } catch (err) {
            helpers.handleError(res, err);
        }
    });

    return router;
};
