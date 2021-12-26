#!/usr/bin/env python3
import re
import os

import yaml
import subprocess


def login_to_argocd(argocd_password, argocd_user, argocd_host):
    result = subprocess.run(
        [
            'argocd', 'login', argocd_host,
            '--grpc-web',
            '--username', argocd_user,
            '--password', argocd_password,
        ],
        capture_output=True
    )

    print(result.stdout)


def clean_environment_name(name):
    clean_name = name.replace('feature/', '').replace('hotfix/', '').replace('bugfix/', '')
    clean_name = re.sub('[^a-zA-Z0-9-]', '', clean_name)[0:8].lower().strip('-')
    return clean_name


def create_preview_environment(app_name, env_name):
    preview_app_name = app_name.replace('-dev-', f'-{env_name}-')
    try:
        subprocess.run(['argocd', 'app', 'get', preview_app_name], check=True, )
    except subprocess.CalledProcessError:
        print(f'{preview_app_name} will be created')
    else:
        print(f'{preview_app_name} already exists')
    dev_config = subprocess.run(
        [
            'argocd', 'app', 'get',
            app_name,
            '-o', 'yaml',
        ],
        capture_output=True
    )
    print("Failed to get configuration of " + app_name + "!")

    try:
        dev_config = yaml.safe_load(dev_config)
        subprocess.run(
            [
                'argocd', 'app', 'create',
                preview_app_name,
                '--project', dev_config['spec']['project'],
                '--dest-server', dev_config['spec']['destination']['server'],
                '--dest-namespace', dev_config['spec']['destination']['namespace'],
                '--repo', dev_config['spec']['source']['repoURL'],
                '--path', dev_config['spec']['source']['path'],
                '--values', 'values.yaml',
                '--values', 'values-dev.yaml',
                '--values-literal-file', os.getenv('DEPLOYMENT_OVERRIDE_VALUES_FILE_NAME'),
                '--parameter', f"global.pillar={dev_config['spec']['source']['helm']['parameters'][0]['value']}",
                '--parameter', f"global.serviceName={dev_config['spec']['source']['helm']['parameters'][1]['value']}",
                '--parameter', f"global.environmentName={env_name}",
                '--parameter', f"global.image.tag={os.getenv('GITHUB_SHA')}",
                '--label', f"original={app_name}",
                '--label', f"branch={env_name}",
                '--label', 'environment=preview',
                '--label', f"repository={os.getenv('GITHUB_REPOSITORY')}",
                '--sync-policy', 'automated',
                '--sync-option', 'Prune=true',
                '--sync-option', 'CreateNamespace=false',
                '--self-heal',
                '--upsert'
            ],
            capture_output=True
        )
        print("Failed to deploy application " + app_name + " to Preview environment: " + env_name + "!")

    except yaml.YAMLError:
        print('Failed to parse configuration.')


def destroy_preview_environment(app_name, env_name):
    preview_app_name = app_name.replace('-dev-', f'-{env_name}-')
    subprocess.run(
        [
            'argocd', 'app', 'delete',
            preview_app_name
        ],
        capture_output=True
    )
    print(f"Failed to destroy application {preview_app_name}")


def destroy_preview_environments(app_name):
    preview_apps = subprocess.run(
        [
            'argocd', 'app', 'list',
            '--selector', 'environment=preview',
            '--selector', f"original={app_name}",
        ],
    )
    print(f"Failed to list preview environments for {app_name}.")
    for preview_app in preview_apps.splitlines():
        subprocess.run(
            [
                'argocd', 'app', 'delete',
                preview_app,
            ],
        )
        print(f"Failed to delete preview environments: {preview_app}.")


if __name__ == '__main__':
    env = os.getenv('ENVIRONMENT_NAME')
    branch = os.getenv('GITHUB_REF_NAME')
    env_name = clean_environment_name(branch)
    app_name = '-'.join([
        os.getenv('TEAM'),
        env,
        os.getenv('SERVICE_NAME')
    ])
    login_to_argocd(os.getenv('ARGOCD_PASSWORD'), os.getenv('ARGOCD_USER'), os.getenv('ARGOCD_HOST'))
    # deployment_type = os.getenv('DEPLOYMENT_TYPE')
    # if deployment_type == 'preview' and env == 'dev':
    #     create_preview_environment(app_name, env_name)
    # elif deployment_type == 'destroy' and env == 'dev':
    #     destroy_preview_environment(app_name, env_name)
    # elif deployment_type == 'clean' and env == 'dev':
    #     destroy_preview_environments(app_name)
    # else:
    #     print(f'DEPLOYMENT_TYPE {deployment_type} should be one of "promote", "preview", "destroy" or "clean".')


