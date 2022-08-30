const yaml = require('js-yaml');
const {execSync} = require('child_process');
const core = require('@actions/core');
const {ECRClient, BatchGetImageCommand, PutImageCommand} = require("@aws-sdk/client-ecr");

const env = process.env.ENVIRONMENT_NAME;
const branch = core.getInput('target-branch');
const commit_hash = core.getInput('target-commit');
const env_name = clean_environment_name(branch);
const app_name = [process.env.TEAM, env, process.env.SERVICE_NAME].join('-');
const argocd_user = process.env.ARGOCD_USER ?? 'bitbucket';
const argocd_wait_timeout = process.env.ARGOCD_WAIT_TIMEOUT ?? 300;
const argocd_sync_wait_timeout = process.env.ARGOCD_SYNC_WAIT_TIMEOUT ?? 300;
const deployment_type = process.env.DEPLOYMENT_TYPE ?? 'promote';
const wait_arguments = process.env.WAIT_ARGUMENTS ?? '--operation --health --sync';
const deployment_override_file_name = process.env.DEPLOYMENT_OVERRIDE_VALUES_FILE_NAME ?? '';
const aws_default_region = process.env.AWS_DEFAULT_REGION ?? 'eu-central-1';

const argocd_servers = {
    dev: 'argocd-dev.infra.aws.7senders.com',
    prod: 'argocd.infra.aws.7senders.com',
}
const argocd_host = env === 'prod' ? argocd_servers.prod : argocd_servers.dev;

login_to_argocd()
    .then(
        _result => {
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
        }
    ).catch(
    e =>
        core.setFailed(`Failed to login into ArgoCD: ${e.message}`)
);

async function login_to_argocd() {
    const command = `argocd login ${argocd_host}:443 --grpc-web --username ${argocd_user} --password "${process.env.ARGOCD_PASSWORD}"`
    execSync(command, {stdio: 'inherit'});
}

function get_client() {
    try {
        return new ECRClient({region: aws_default_region});
    } catch (e) {
        core.setFailed("Failed to create ECR client.");
    }
}

async function promote_image() {
    const client = get_client();
    const image_name = process.env.DOCKER_REPO ?? process.env.IMAGE_NAME;
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
        core.info(`Manifest for ${image_name} : ${commit_hash} in not found. You should run manually or wait for finishing the build step in your pipeline.`);
    }
    const current_manifest = current_image['images'][0]['imageManifest'];
    const check_previous_image = new BatchGetImageCommand({
        repositoryName: image_name,
        imageIds: [
            {
                'imageTag': env
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
        core.info(`Promoting ${image_name}:latest to ${env} environment.`);
        const put_docker_image = new PutImageCommand({
            repositoryName: image_name,
            imageManifest: current_manifest,
            imageTag: env
        });
        await client.send(put_docker_image);
    } else {
        core.info("Promoting is not necessary, the same image exists in ECR.");
    }
    return true;
}

function deploy_to_argocd() {
    try {
        if (process.env.SERVICE_NAME == "airflow") {
            // this is exceptional case for airflow deployments as it is using custom helm chart, rather than "deployment" chart
            const deploy_app = `argocd app set ${app_name} --parameter airflow.airflow.image.tag=${commit_hash}`
        } else {
            const deploy_app = `argocd app set ${app_name} --parameter global.image.tag=${commit_hash}`
        }
        execSync(deploy_app);
        core.info(`The new image: ${commit_hash} was set.`);
    } catch (error) {
        core.setFailed(`Failed to update application ${app_name} with image ${commit_hash}!`);
    }
    try {
        const wait_operation = `argocd app wait ${app_name} --operation --health --timeout ${argocd_wait_timeout}`
        execSync(wait_operation);
        core.info(`${app_name} is green.`);
    } catch (error) {
        core.setFailed(`Failed to wait for application ${app_name} change complete.`);
    }
    try {
        const app_sync = `argocd app sync ${app_name}`
        execSync(app_sync);
    } catch (error) {
        core.setFailed(`Failed to deploy application ${app_name} to ${env} environment!`);
    }
    try {

        const wait_sync = `argocd app wait ${app_name} ${wait_arguments} --timeout ${argocd_sync_wait_timeout}`
        execSync(wait_sync);
        core.info(`${app_name} was synced.`);
    } catch (error) {
        core.setFailed(`Failed to wait for sync application ${app_name} change complete.`);
    }
    core.info(`${app_name} was deployed.`);
}

function clean_environment_name(name) {
    const clean_name = name
        .replace('feature/', '')
        .replace('hotfix/', '')
        .replace('bugfix/', '')
        .replace('-', '');
    return clean_name.slice(0, 8)
        .replaceAll(/[^a-zA-Z\d-]+/g, '')
        .replace(/^-+/g, '')
        .replace(/-+$/g, '')
        .replaceAll(/-/g, '')
        .toLowerCase();
}

function create_preview_environment() {
    const preview_app_name = app_name.replace('-dev-', `-${env_name}-`);
    try {
        const check_exists = `argocd app get ${preview_app_name}`
        execSync(check_exists, {stdio: 'ignore'});
        try {
            const update_image = `argocd app set ${preview_app_name} --parameter global.image.tag=${commit_hash} --values-literal-file ${deployment_override_file_name}`
            execSync(update_image);
            core.info(`The new image: ${commit_hash} was set.`);
        } catch (error) {
            core.setFailed(`The new image: ${commit_hash} wasn't set.`);
        }
        try {
            const wait_operation = `argocd app wait ${preview_app_name} --operation --health --timeout ${argocd_wait_timeout}`
            execSync(wait_operation);
            core.info(`${preview_app_name} is green.`);
        } catch (error) {
            core.setFailed(`${preview_app_name} is red. Please check the argocd web interface.`);
        }
        try {
            const sync = `argocd app sync ${preview_app_name}`
            execSync(sync);
        } catch (error) {
            core.setFailed("I can't run the sync command. Please check the argocd web interface.");
        }
        try {
            const wait_sync = `argocd app wait ${preview_app_name} --operation --health --sync --timeout ${argocd_sync_wait_timeout}`
            execSync(wait_sync);
            core.info(`${preview_app_name} was synced.`);
        } catch (error) {
            core.setFailed(`${preview_app_name} wasn't synced. Please check the argocd web interface.`);
        }
        core.info(`${preview_app_name} was deployed.`);
    } catch (error) {
        core.info(`${preview_app_name} will be created.`);
        try {
            const get_config = `argocd app get ${app_name} -o yaml`;
            const dev_config = execSync(get_config);
            try {
                const config = yaml.load(dev_config);
                const create_command = `
                    argocd app create ${preview_app_name} \
                        --project ${config['spec']['project']} \
                        --dest-server ${config['spec']['destination']['server']} \
                        --dest-namespace ${config['spec']['destination']['namespace']} \
                        --repo ${config['spec']['source']['repoURL']} \
                        --path ${config['spec']['source']['path']} \
                        --values values.yaml --values values-dev.yaml \
                        --values-literal-file ${deployment_override_file_name} \
                        --parameter global.pillar=${config['spec']['source']['helm']['parameters'][0]['value']} \
                        --parameter global.serviceName=${config['spec']['source']['helm']['parameters'][1]['value']} \
                        --parameter global.environmentName=${env_name} \
                        --parameter global.image.tag=${commit_hash} \
                        --parameter deployment.fullnameOverride=${preview_app_name} \
                        --label original=${app_name} \
                        --label branch=${env_name} \
                        --label environment=preview \
                        --label repository=${process.env.GITHUB_REPOSITORY.replace('SevenSenders/', '')} \
                        --sync-policy automated \
                        --sync-option Prune=true \
                        --sync-option CreateNamespace=false \
                        --self-heal \
                        --upsert
                        `;
                execSync(create_command);
                core.info(`${preview_app_name} was created!`);
            } catch (e) {
                core.setFailed(`Failed to deploy application ${app_name} to Preview environment: ${env_name}!`);
            }
        } catch (e) {
            core.setFailed(`Failed to get configuration of ${app_name}!`);
        }
    }
    core.info(`The ArgoCD link for your application: https://${argocd_host}/applications/${process.env.TEAM}-${env_name}-${process.env.SERVICE_NAME}`);
}

function destroy_preview_environment() {
    const preview_app_name = app_name.replace('-dev-', `-${env_name}-`);
    try {
        const delete_command = `argocd app delete ${preview_app_name}`
        execSync(delete_command);
        core.info(`${preview_app_name} was destroyed!`);
    } catch (e) {
        core.setFailed(`Failed to destroy application ${preview_app_name}!`);
    }
}

function destroy_preview_environments() {
    try {
        const preview_apps_command = `argocd app list -o name --selector environment=preview --selector original=${app_name}`
        const preview_apps = execSync(preview_apps_command).toString();
        const list_of_apps = preview_apps.split(/\r?\n/).filter(item => item);
        let delete_app;
        list_of_apps.forEach(function (app) {
            try {
                delete_app = `argocd app delete ${app}`
                execSync(delete_app);
                core.warning(`${delete_app} was deleted.`);
            } catch (e) {
                core.setFailed(`Failed to delete preview environments: ${delete_app}!`);
            }
        });
    } catch (e) {
        core.setFailed(`Failed to list preview environments for ${app_name}!`);
    }
}

function deployment_promotion() {
    promote_image()
        .then(
            result => {
                if (result) {
                    core.info(`Deploying application ${app_name} to ${env} environment`);
                    core.info(`Details at https://${argocd_host}/applications/${app_name}`);
                    deploy_to_argocd();
                    core.info(`Successfully deployed application ${app_name} to ${env} environment!`);
                }
            }
        )
        .catch(
            e =>
                core.setFailed(e.message)
        );
}
