const { parseArgsStringToArgv } = require('string-argv');
const yaml = require('js-yaml');
const { execSync } = require('child_process');


function login_to_argocd() {
    try {
        const command = 'argocd login ' + process.env.ARGOCD_HOST +
            ' --grpc-web --username ' + process.env.ARGOCD_USER +
            ' --password "' + process.env.ARGOCD_PASSWORD + '"'
        execSync(command, {stdio: 'inherit'});
    } catch (error) {
    }
}

function clean_environment_name(name) {
    const clean_name = name.replace('feature/', '').replace('hotfix/', '').replace('bugfix/', '')
    return clean_name.replaceAll(/[^a-zA-Z0-9-]+/g, '').replace(/^-+|-+$/g, '').toLowerCase()
}

function create_preview_environment(app_name, env_name) {
    const preview_app_name = app_name.replace('-dev-', '-' + env_name + '-')
    try {
        const check_exists = 'argocd app get ' + preview_app_name
        execSync(check_exists, { stdio: 'ignore' });
    } catch (error) {
        console.log(preview_app_name + " will be created.");
    }
    try {
        const get_config = 'argocd app get ' + app_name + ' -o yaml'
        const dev_config = execSync(get_config);
        try {
            const config = yaml.load(dev_config);
            const create_command = 'argocd app create ' +
                preview_app_name +
                ' --project ' + config['spec']['project'] +
                ' --dest-server ' + config['spec']['destination']['server'] +
                ' --dest-namespace ' + config['spec']['destination']['namespace'] +
                ' --repo ' + config['spec']['source']['repoURL'] +
                ' --path ' + config['spec']['source']['path'] +
                ' --values values.yaml --values values-dev.yaml' +
                ' --values-literal-file ' + process.env.DEPLOYMENT_OVERRIDE_VALUES_FILE_NAME +
                ' --parameter global.pillar=' + config['spec']['source']['helm']['parameters'][0]['value'] +
                ' --parameter global.serviceName=' + config['spec']['source']['helm']['parameters'][1]['value'] +
                ' --parameter global.environmentName=' + env_name +
                ' --parameter global.image.tag=' + process.env.GITHUB_SHA +
                ' --parameter deployment.fullnameOverride=' + preview_app_name +
                ' --label original=' + app_name +
                ' --label branch=' + env_name +
                ' --label environment=preview --label repository=' + process.env.GITHUB_REPOSITORY.replace('SevenSenders/', '') +
                ' --sync-policy automated --sync-option Prune=true --sync-option CreateNamespace=false --self-heal --upsert'
            execSync(create_command)
            console.log(preview_app_name + " was created!")
        } catch (e) {
            console.log("Failed to deploy application " + app_name + " to Preview environment: " + env_name + "!")
        }
    } catch (e) {
        console.log("Failed to get configuration of " + app_name + "!")
    }
}

function destroy_preview_environment(app_name, env_name) {
    const preview_app_name = app_name.replace('-dev-', '-' + env_name + '-')
    try {
        const delete_command = 'argocd app delete ' + preview_app_name
        execSync(delete_command)
        console.log(preview_app_name + " was destroyed!")
    } catch (e) {
        console.log("Failed to destroy application " + preview_app_name + "!")
    }
}

function destroy_preview_environments(app_name) {
    try {
        const preview_apps_command = 'argocd app list -o name --selector environment=preview --selector original=' + app_name
        const preview_apps = execSync(preview_apps_command).toString()
        const list_of_apps = preview_apps.split(/\r?\n/).filter(item => item);
        list_of_apps.forEach(function (app) {
            try {
                const delete_app = 'argocd app delete ' + app
                execSync(delete_app)
                console.log(delete_app + " was deleted.")
            } catch (e) {
                console.log("Failed to delete preview environments: " + delete_app + "!")
            }
        });
    } catch (e) {
        console.log("Failed to list preview environments for " + app_name + "!")
    }
}

const env = process.env.ENVIRONMENT_NAME
const branch = process.env.GITHUB_REF_NAME
const env_name = clean_environment_name(branch)
const app_name = [ process.env.TEAM, env, process.env.SERVICE_NAME ].join('-')
login_to_argocd();
deployment_type = process.env.DEPLOYMENT_TYPE
if (deployment_type === 'preview' & env === 'dev') {
    create_preview_environment(app_name, env_name)
} else if (deployment_type === 'destroy' & env === 'dev') {
    destroy_preview_environment(app_name, env_name)
} else if (deployment_type === 'clean' & env === 'dev') {
    destroy_preview_environments(app_name)
} else {
    console.log('DEPLOYMENT_TYPE ' + deployment_type + ' should be one of "promote", "preview", "destroy" or "clean".')
}