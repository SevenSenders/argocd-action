const yaml = require('js-yaml');
const { execSync } = require('child_process');
const core = require('@actions/core');
const { ECRClient, BatchGetImageCommand, PutImageCommand } = require("@aws-sdk/client-ecr");

function get_client() {
    try {
        return new ECRClient({ region: process.env.AWS_DEFAULT_REGION });
    } catch (e) {
        console.log("Failed to create ECR client.");
        process.exit(1);
    }
}

async function promote_image(env_name, commit_hash) {
    const client = get_client();
    const image_name = process.env.DOCKER_REPO;
    const check_image = new BatchGetImageCommand({
        repositoryName: image_name,
        imageIds: [
            {
                'imageTag':commit_hash
            }
        ]
    });
    const current_image = await client.send(check_image);
    if (current_image.images.length === 0) {
        console.log("Manifest for " + image_name + " : " + commit_hash
            + " in not found. You should run manually or wait for finishing the build step in your pipeline.");
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
    } else {
        console.log("Promoting is not necessary, the same image exists in ECR.");
        return true;
    }
    return false;

}

function login_to_argocd() {
    try {
        const command = 'argocd login ' + process.env.ARGOCD_HOST +
            ' --grpc-web --username ' + process.env.ARGOCD_USER +
            ' --password "' + process.env.ARGOCD_PASSWORD + '"'
        execSync(command, {stdio: 'inherit'});
    } catch (error) {
        process.exit(1);
    }
}

function deploy_to_argocd(app_name, commit_hash) {
    try {
        const deploy_app = 'argocd app set ' + app_name +
            ' --parameter global.image.tag=' + commit_hash
        execSync(deploy_app);
        console.log("The new image: " + commit_hash + " was set.");
    } catch (error) {
        console.log("Failed to update application " + app_name + "with image " + commit_hash + "!");
        process.exit(1);
    }
    try {
        const wait_operation = 'argocd app wait ' + app_name +
            ' --operation --health --timeout ' + process.env.ARGOCD_WAIT_TIMEOUT
        execSync(wait_operation);
        console.log(app_name + " is green.");
    } catch (error) {
        console.log("Failed to wait for application " + app_name + "change complete.");
        process.exit(1);
    }
    try {
        const app_sync = 'argocd app sync ' + app_name
        execSync(app_sync);
    } catch (error) {
        console.log("Failed to deploy application " + app_name +
            " to " + process.env.ENVIRONMENT_NAME + " environment!");
        process.exit(1);
    }
    try {
        const wait_sync = 'argocd app wait ' + app_name +
            ' --operation --health --sync --timeout ' + process.env.ARGOCD_SYNC_WAIT_TIMEOUT
        execSync(wait_sync);
        console.log(app_name + " was synced.");
    } catch (error) {
        console.log("Failed to wait for sync application " + app_name + " change complete.");
        process.exit(1);
    }
    console.log(app_name + " was deployed.");
}

function clean_environment_name(name) {
    const clean_name = name.replace('feature/', '').replace('hotfix/', '').replace('bugfix/', '');
    return clean_name.replaceAll(/[^a-zA-Z0-9-]+/g, '').replace(/^-+|-+$/g, '').toLowerCase();
}

function create_preview_environment(app_name, env_name, commit_hash) {
    const preview_app_name = app_name.replace('-dev-', '-' + env_name + '-');
    try {
        const check_exists = 'argocd app get ' + preview_app_name
        execSync(check_exists, { stdio: 'ignore' });
        try {
            const update_image = 'argocd app set ' + preview_app_name +
                ' --parameter global.image.tag=' + commit_hash +
                ' --values-literal-file ' + process.env.DEPLOYMENT_OVERRIDE_VALUES_FILE_NAME
            execSync(update_image);
            console.log("The new image: " + commit_hash + " was set.");
        } catch (error) {
            console.log("The new image: " + commit_hash + " wasn't set.");
            process.exit(1);
        }
        try {
            const wait_operation = 'argocd app wait ' + preview_app_name +
                ' --operation --health --timeout ' + process.env.ARGOCD_WAIT_TIMEOUT
            execSync(wait_operation);
            console.log(preview_app_name + " is green.");
        } catch (error) {
            console.log(preview_app_name + " is red. Please check the argocd web interface.");
            process.exit(1);
        }
        try {
            const sync = 'argocd app sync ' + preview_app_name
            execSync(sync);
        } catch (error) {
            console.log(" I can't run the sync command. Please check the argocd web interface.");
            process.exit(1);
        }
        try {
            const wait_sync = 'argocd app wait ' + preview_app_name +
                ' --operation --health --sync --timeout ' + process.env.ARGOCD_SYNC_WAIT_TIMEOUT
            execSync(wait_sync);
            console.log(preview_app_name + " was synced.");
        } catch (error) {
            console.log(preview_app_name + " wasn't synced. Please check the argocd web interface.");
            process.exit(1);
        }
        console.log(preview_app_name + " was deployed.");
    } catch (error) {
        console.log(preview_app_name + " will be created.");
        try {
            const get_config = 'argocd app get ' + app_name + ' -o yaml';
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
                    ' --parameter global.image.tag=' + commit_hash +
                    ' --parameter deployment.fullnameOverride=' + preview_app_name +
                    ' --label original=' + app_name +
                    ' --label branch=' + env_name +
                    ' --label environment=preview --label repository=' + process.env.GITHUB_REPOSITORY.replace('SevenSenders/', '') +
                    ' --sync-policy automated --sync-option Prune=true --sync-option CreateNamespace=false --self-heal --upsert'
                execSync(create_command);
                console.log(preview_app_name + " was created!");
            } catch (e) {
                console.log("Failed to deploy application " + app_name + " to Preview environment: " + env_name + "!");
                process.exit(1);
            }
        } catch (e) {
            console.log("Failed to get configuration of " + app_name + "!");
            process.exit(1);
        }
    }
    console.log("The ArgoCD link for your application: https://" +
        process.env.ARGOCD_HOST + "/applications/" + process.env.TEAM + "-" + env_name +
        "-" + process.env.SERVICE_NAME );
}

function destroy_preview_environment(app_name, env_name) {
    const preview_app_name = app_name.replace('-dev-', '-' + env_name + '-');
    try {
        const delete_command = 'argocd app delete ' + preview_app_name
        execSync(delete_command);
        console.log(preview_app_name + " was destroyed!");
    } catch (e) {
        console.log("Failed to destroy application " + preview_app_name + "!");
        process.exit(1);
    }
}

function destroy_preview_environments(app_name) {
    try {
        const preview_apps_command = 'argocd app list -o name --selector environment=preview --selector original=' + app_name
        const preview_apps = execSync(preview_apps_command).toString();
        const list_of_apps = preview_apps.split(/\r?\n/).filter(item => item);
        list_of_apps.forEach(function (app) {
            try {
                const delete_app = 'argocd app delete ' + app
                execSync(delete_app);
                console.log(delete_app + " was deleted.");
            } catch (e) {
                console.log("Failed to delete preview environments: " + delete_app + "!");
                process.exit(1);
            }
        });
    } catch (e) {
        console.log("Failed to list preview environments for " + app_name + "!");
        process.exit(1);
    }
}

function deployment_promotion(app_name, env, commit_hash) {
    promote_image(env, commit_hash).then(result => {
        if (result) {
            console.log("Deploying application " + app_name + " to " + env + " environment.");
            console.log("Details at https://" + process.env.ARGOCD_HOST + "/applications/" + app_name + ".");
            deploy_to_argocd(app_name, commit_hash);
            console.log("Successfully deployed application " + app_name + " to " + env + " environment!");
        }
    }).catch(e => console.log(e))
}

const env = process.env.ENVIRONMENT_NAME;
const branch = core.getInput('target-branch');
const commit_hash = core.getInput('target-commit');
const env_name = clean_environment_name(branch);
const app_name = [ process.env.TEAM, env, process.env.SERVICE_NAME ].join('-');
login_to_argocd();
deployment_type = process.env.DEPLOYMENT_TYPE;
if (deployment_type === 'promote') {
    deployment_promotion(app_name, env, commit_hash);
} else if (deployment_type === 'preview' & env === 'dev') {
    create_preview_environment(app_name, env_name, commit_hash);
} else if (deployment_type === 'destroy' & env === 'dev') {
    destroy_preview_environment(app_name, env_name);
} else if (deployment_type === 'clean' & env === 'dev') {
    destroy_preview_environments(app_name);
} else {
    console.log('DEPLOYMENT_TYPE ' + deployment_type + ' should be one of "promote", "preview", "destroy" or "clean".');
}