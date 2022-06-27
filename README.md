# ArgoCD features environment action

This action deploys the feature environment of your application.

## Variables

| Variable | Usage |
|----------|-------|
| ENVIRONMENT_NAME (*)| Name of the environment for the deployment, e.g. "dev", "stage", "prod", "feature-X", recommeded to be accessed from deployment variables.|
| IMAGE_NAME (*) | Name of the ECR repository, e.g. "012345678.dkr.ecr.eu-central-1.amazonaws.com/example", recommended to be accessed from repository variables. |
| SERVICE_NAME (*) | Name of the service endpoint, will be accessible via load-balancer, recommended to be accessed from repository variables.|
| TEAM (*)                  | Name of the team, will deploy into team namespace, recommended to be accessed from repository variables.|
| ARGOCD_USER               | ArgoCD user. Default `bitbucket`.|
| ARGOCD_PASSWORD (*)       | Bitbucket password for ArgoCD, available from global variables.|
| ARGOCD_WAIT               | Wait for successful completion of the deployment. Default `true`.|
| DEBUG                     | Turn on extra debug information. Default: `false`. |
| DEPLOYMENT_TYPE           | Type of the deployment: `promote`, `preview`, `destroy`, `clean`. Default: `promote`. |
| ARGOCD_WAIT_TIMEOUT       | Wait for the existing operations progress to finish. Defaults 300 |
| ARGOCD_SYNC_WAIT_TIMEOUT  | Wait for the Argo CD sync progress  to finish. Defaults 300 |
| DEPLOYMENT_OVERRIDE_VALUES_FILE_NAME | Configuration of the feature environment. Defaults ''|
| WAIT_ARGUMENTS | Confiuration of the wait logic. Defaults `--operation --health --sync`|

_(*) = required variable._

## Inputs

## `target-branch`

**Required** The branch which will be set as a part of the argocd aplication name.

## `target-commit`

**Required** The commit which will be set as a docker image tag.

## Outputs

##

## Example usage

uses: SevenSenders/argocd-action@v0.1.0
