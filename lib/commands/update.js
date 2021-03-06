'use strict';
const fs = require('fs-extra');
const path = require('path');
const Listr = require('listr');
const symlinkSync = require('symlink-or-copy').sync;

// Utils
const errors = require('../errors');
const Config = require('../utils/config');
const resolveVersion = require('../utils/resolve-version');
const checkValidInstall = require('../utils/check-valid-install');

// Tasks/Commands
// TODO: update checks
const yarnInstall = require('../tasks/yarn-install');
const stopCommand = require('./stop');
const startCommand = require('./start');

const tasks = {
    version: (ctx) => resolveVersion(ctx.version, ctx.force ? null : ctx.activeVersion).then((version) => {
        ctx.version = version;
        ctx.installPath = path.join(process.cwd(), 'versions', version);
    }),
    link: (ctx) => {
        fs.removeSync(path.join(process.cwd(), 'current'));
        symlinkSync(ctx.installPath, path.join(process.cwd(), 'current'));

        ctx.config.set('previous-version', ctx.rollback ? null : ctx.config.get('active-version'))
            .set('active-version', ctx.version).save();
    }
};

module.exports.execute = function execute(version, options) {
    checkValidInstall('update');

    let config = Config.load('.ghost-cli');
    let context = {
        config: config,
        force: options.force,
        activeVersion: config.get('active-version'),
        version: version
    };

    if (options.rollback) {
        if (!config.get('previous-version')) {
            throw new Error('No previous version found');
        }

        context.rollback = true;
        context.version = config.get('previous-version');
        context.installPath = path.join(process.cwd(), 'versions', context.version);
    }

    // If Ghost isn't currently running, we want to make sure that we use the right config file
    // instead of relying on the environment set when ghost is started
    if (!this.development && fs.existsSync(path.join(process.cwd(), 'config.development.json')) &&
            !fs.existsSync(path.join(process.cwd(), 'config.production.json'))) {
        this.development = false;
        process.env.NODE_ENV = this.environment = 'development';
    }

    context.environment = config.get('running', this.environment);

    this.service.setConfig(Config.load(context.environment));

    return new Listr([{
        title: 'Checking for latest Ghost version',
        skip: (ctx) => ctx.rollback,
        task: tasks.version
        // TODO: add meaningful update checks after this task
    }, {
        title: 'Downloading and updating Ghost',
        skip: (ctx) => ctx.rollback,
        task: (ctx, task) => {
            task.title = `Downloading and updating Ghost to v${ctx.version}`;
            return yarnInstall(ctx.renderer);
        }
    }, {
        title: 'Stopping Ghost',
        skip: (ctx) => !ctx.environment,
        task: () => stopCommand.execute.call(this, {quiet: true}).catch((error) => {
            if (error instanceof errors.SystemError && error.message.match(/No running Ghost instance/)) {
                return;
            }

            return Promise.reject(error);
        })
    }, {
        title: 'Linking things',
        task: tasks.link
    }, {
        title: 'Restarting Ghost',
        task: () => startCommand.execute.call(this, {quiet: true})
    }], {renderer: this.renderer}).run(context);
};
