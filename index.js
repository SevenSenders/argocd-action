const yaml = require('js-yaml');
const {execSync} = require('child_process');
const core = require('@actions/core');
const {ECRClient, BatchGetImageCommand, PutImageCommand} = require("@aws-sdk/client-ecr");

function get_client() {
    try {
        return new ECRClient({
            region: process.env.AWS_DEFAULT_REGION
        });
    } catch (e) {
        core.setFailed("Failed to create ECR client.");
    }
}

async function promote_image() {
    const client = get_client();
    const image_name = process.env.DOCKER_REPO;
    const check_image = new BatchGetImageCommand({
        repositoryName: image_name,
        imageIds: [
            {
                'imageTag': commit_hash
            }
        ]
    });
    const current_image = await client.send(check_image);
    if (current_image.images.length === 0) {
        core.setFailed(`Manifest for ${image_name}: '${commit_hash}' in not found. You should run manually or wait for finishing the build step in your pipeline.`);
    }
    const current_manifest = current_image['images'][0]['imageManifest'];
    const check_previous_image = new BatchGetImageCommand({
        repositoryName: image_name,
        imageIds: [
            {
                'imageTag': env_name
            }
        ]
    });
    let previous_manifest;
    const previous_image = await client.send(check_previous_image);
    if (previous_image.images.length !== 0) {
        previous_manifest = previous_image['images'][0]['imageManifest'];
    } else {
        previous_manifest = 'NOT FOUND';
    }
    if (current_manifest !== previous_manifest) {
        console.log("Promoting " + image_name + ":latest to " + env_name + " environment.");
        const put_docker_image = new PutImageCommand({
            repositoryName: image_name,
            imageManifest: current_manifest,
            imageTag: env_name
        });
        await client.send(put_docker_image);
        return true;
    }
    return false;
}

function login_to_argocd() {
    try {
        core.setSecret(process.env.ARGOCD_PASSWORD);
        const command = `argocd login ${process.env.ARGOCD_HOST} --grpc-web --username ${process.env.ARGOCD_USER} --password ${process.env.ARGOCD_PASSWORD}`
        execSync(command, {stdio: 'inherit'});
    } catch (error) {
        core.setFailed(`Failed to login into ArgoCD ${process.env.ARGOCD_HOST}.`);
    }
}

function deploy_to_argocd() {
    try {
        const deploy_app = `argocd app set ${app_name} --parameter global.image.tag=${commit_hash}`
        execSync(deploy_app);
        console.log(`The new image: ${commit_hash} was set.`);
    } catch (error) {
        core.setFailed(`Failed to update application ${app_name} with image ${commit_hash}: ${app_url}`);
    }
    try {
        const wait_operation = `argocd app wait ${app_name} --operation --health --timeout ${argocd_wait_timeout}`
        execSync(wait_operation);
        console.log(`${app_name} is green.`);
    } catch (error) {
        core.setFailed(`Failed to wait for application ${app_name} change complete: ${app_url}`);
    }
    try {
        const app_sync = `argocd app sync ${app_name}`
        execSync(app_sync);
    } catch (error) {
        core.setFailed(`Failed to deploy application ${app_name} to ${env} environment: ${app_url}`);
    }
    try {
        const wait_sync = `argocd app wait ${app_name} --operation --health --sync --timeout ${argocd_sync_timeout}`
        execSync(wait_sync);
        console.log(`${app_name} was synced.`);
    } catch (error) {
        core.setFailed(`Failed to wait for sync application ${app_name} change complete: ${app_url}`);
    }
    console.log(app_name + " was deployed.");
}

function clean_environment_name(name) {
    return name
        .replaceAll(/^(feature|hotfix|bugfix)\//, '')
        .replaceAll(/[^a-zA-Z0-9-]+/g, '')
        .replaceAll(/(^-+)|(-+$)/g, '')
        .toLowerCase();
}

function create_preview_environment() {
    const preview_app_name = app_name.replace('-dev-', `-${env_name}-`);
    try {
        const check_exists = `argocd app get ${preview_app_name}`
        execSync(check_exists, {stdio: 'ignore'});
        try {
            const values_file = process.env.DEPLOYMENT_OVERRIDE_VALUES_FILE_NAME;
            const update_image = `argocd app set ${preview_app_name} --parameter global.image.tag=${commit_hash} --values-literal-file ${values_file}`
            execSync(update_image);
            console.log(`The new image: ${commit_hash} was set.`);
        } catch (error) {
            core.setFailed(`The new image: ${commit_hash} wasn't set: ${app_preview_url}`);
        }
        try {
            const wait_operation = `argocd app wait ${preview_app_name} --operation --health --timeout ${argocd_wait_timeout}`
            execSync(wait_operation);
            console.log(`${preview_app_name} is green.`);
        } catch (error) {
            core.setFailed(`${preview_app_name} is red: ${app_preview_url}`);
        }
        try {
            const sync = `argocd app sync ${preview_app_name}`
            execSync(sync);
        } catch (error) {
            core.setFailed(`Sync failed: ${app_preview_url}`);
        }
        try {
            const wait_sync = `argocd app wait ${preview_app_name} --operation --health --sync --timeout ${argocd_sync_timeout}`
            execSync(wait_sync);
            console.log(`${preview_app_name} was synced.`);
        } catch (error) {
            core.setFailed(`${preview_app_name} wasn't synced: ${app_preview_url}`);
        }
        console.log(`${preview_app_name} was deployed.`);
    } catch (error) {
        console.log(`${preview_app_name} will be created.`);
        try {
            const get_config = `argocd app get ${app_name} -o yaml`;
            const dev_config = execSync(get_config);
            try {
                const config = yaml.load(dev_config, 'utf8');
                const create_command = [
                    `argocd app create ${preview_app_name}`,
                    `--project ${config['spec']['project']}`,
                    `--dest-server ${config['spec']['destination']['server']}`,
                    `--dest-namespace ${config['spec']['destination']['namespace']}`,
                    `--repo ${config['spec']['source']['repoURL']}`,
                    `--path ${config['spec']['source']['path']}`,
                    '--values values.yaml',
                    '--values values-dev.yaml' +
                    `--values-literal-file ${process.env.DEPLOYMENT_OVERRIDE_VALUES_FILE_NAME}`,
                    `--parameter global.pillar=${config['spec']['source']['helm']['parameters'][0]['value']}`,
                    `--parameter global.serviceName=${config['spec']['source']['helm']['parameters'][1]['value']}`,
                    `--parameter global.environmentName=${env_name}`,
                    `--parameter global.image.tag=${commit_hash}`,
                    `--parameter deployment.fullnameOverride=${preview_app_name}`,
                    `--label original=${app_name}`,
                    `--label branch=${env_name}`,
                    '--label environment=preview',
                    `--label repository=${process.env.GITHUB_REPOSITORY.replace('SevenSenders/', '')}`,
                    '--sync-policy automated',
                    '--sync-option Prune=true',
                    '--sync-option CreateNamespace=false',
                    '--self-heal',
                    '--upsert'
                ].join(' ')
                execSync(create_command);
                console.log(`${preview_app_name} was created!`);
            } catch (e) {
                core.setFailed(`Failed to deploy application ${app_name} to preview environment ${env_name}`);
            }
        } catch (e) {
            core.setFailed(`Failed to get configuration of ${app_name}: ${app_url}`);
        }
    }
    console.log(`The ArgoCD link for your application: ${app_preview_url}`);
}

function destroy_preview_environment() {
    const preview_app_name = app_name.replace('-dev-', `-${env_name}-`);
    try {
        const delete_command = `argocd app delete ${preview_app_name}`
        execSync(delete_command);
        console.log(`${preview_app_name} was destroyed!`);
    } catch (e) {
        core.setFailed(`Failed to destroy application ${preview_app_name}!`);
    }
}

function destroy_preview_environments() {
    try {
        const preview_apps_command = `argocd app list -o name --selector environment=preview --selector original=${app_name}`
        const preview_apps = execSync(preview_apps_command).toString();
        const list_of_apps = preview_apps.split(/\r?\n/).filter(item => item);
        list_of_apps.forEach(function (app) {
            const delete_app = `argocd app delete ${app}`
            try {
                execSync(delete_app);
                console.log(`${delete_app} was deleted.`);
            } catch (e) {
                core.setFailed(`Failed to delete preview environments: ${delete_app}!`);
            }
        });
    } catch (e) {
        core.setFailed(`Failed to list preview environments for ${app_name}!`);
    }
}

function deployment_promotion() {
    promote_image().then(result => {
        if (result) {
            console.log(`Deploying application ${app_name} to ${env} environment.`);
            console.log(`Details at ${app_url}.`);
            deploy_to_argocd();
            console.log(`Successfully deployed application ${app_name} to ${env} environment!`);
        }
    }).catch(e => console.log(e))
}

const env = process.env.ENVIRONMENT_NAME;
const argocd_wait_timeout = process.env.ARGOCD_SYNC_WAIT_TIMEOUT;
const argocd_sync_timeout = process.env.ARGOCD_SYNC_WAIT_TIMEOUT;
const branch = core.getInput('target-branch');
const commit_hash = core.getInput('target-commit');
const env_name = clean_environment_name(branch);
const app_name = [process.env.TEAM, env, process.env.SERVICE_NAME].join('-');
const preview_name = [process.env.TEAM, env_name, process.env.SERVICE_NAME].join('-');
const app_url = `https://${process.env.ARGOCD_HOST}/applications/${app_name}`;
const app_preview_url = `https://${process.env.ARGOCD_HOST}/applications/${preview_name}`;
try {
    login_to_argocd();

    const deployment_type = process.env.DEPLOYMENT_TYPE;
    switch (deployment_type) {
        case 'promote':
            deployment_promotion();
            break;
        case 'preview':
            create_preview_environment();
            break;
        case 'destroy':
            destroy_preview_environment();
            break;
        case 'clean':
            destroy_preview_environments();
            break;
        default:
            core.setFailed(`DEPLOYMENT_TYPE ${deployment_type} should be one of "promote", "preview", "destroy" or "clean".`);
    }
} catch (error) {
    core.setFailed(error.message)
}

