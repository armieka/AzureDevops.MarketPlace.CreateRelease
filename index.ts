import * as taskLib from 'azure-pipelines-task-lib/task';
import "isomorphic-fetch";
import { delay } from 'q';

async function GetDefinitionIdAsync(headers: HeadersInit, projectName: string, releaseName: string): Promise<number> {
    return fetch('https://vsrm.dev.azure.com/beslistnl/' + projectName + '/_apis/release/definitions?api-version=5.0&searchText=' + releaseName + '&isExactNameMatch=true',
        {
            headers: headers,
            method: 'GET'
        })
        .then(function (response) {
            if (response.ok) {
                return response.json();
            }
            throw Error(response.statusText);
        })
        .then(function (jsonResult) {
            if (jsonResult.count != 1) {
                throw Error('to many release definitions');
            }
            else {
                return jsonResult.value[0].id;
            }
        });
}

async function GetBuildArtifactAsync(headers: HeadersInit, projectName: string, definitionId: number): Promise<string> {
    return fetch('https://vsrm.dev.azure.com/beslistnl/' + projectName + '/_apis/release/deployments?api-version=5.0&query+Order=descending&deploymentStatus=succeeded&definitionId=' + definitionId,
        {
            headers: headers,
            method: 'GET'
        }).then(function (response) {
            if (response.ok) {
                return response.json();
            }
            throw Error(response.statusText);
        }).then(function (jsonResult) {
            let result=jsonResult.value.reduce(function (artifacts: {[name:string]: string}, deploymentType: any) {
                artifacts[deploymentType.releaseEnvironment.name.toLowerCase()] = '"artifacts": [' + deploymentType.release.artifacts.map(function (artifact: any) {
                    return '{ "alias": "' + artifact.alias + '",' +
                        '"instanceReference": {' +
                        '"name": "' + artifact.definitionReference.version.name + '",' +
                        '"id": "' + artifact.definitionReference.version.id + '"}' +
                        '}';
                }).join(',') + ']';
                return artifacts;
            }, {});
            return result['production']; //should be set by user either via ui dropdown see release in normal flow or typed
        });
}

async function GetEnvironmentsAsync(headers: HeadersInit, projectName: string, definitionId: number, environmentName: string): Promise<string> {

    return fetch('https://vsrm.dev.azure.com/beslistnl/' + projectName + '/_apis/Release/definitions/' + definitionId + '?api-version=5.0',
        {
            headers: headers,
            method: 'GET'
        }).then(function (response) {
            if (response.ok) {
                return response.json();
            }
            throw Error(response.statusText);
        }).then(function (jsonResult) {
            return jsonResult.environments.reduce(function (x: string, environment: any) {
                if (environment.name != environmentName) {
                    return x + ',' + '\"' + environment.name + '\"';
                }
                return x;
            }, "");
        });
}


function CreateReleaseBody(definitionId: number, manualEnvironments: string, artifact: string, attributes: { [id: string]: string }): string {

    let variables = '"variables": {' + Object.keys(attributes).reduce(function (x: string[], id: string) {
        x.push('"' + id + '":{"value":"' + attributes[id] + '"}');
        return x;
    }, []).join(',') + '}';
    let description = 'triggered by integration test';
    return '{"definitionId": ' + definitionId + ',' +
        ',"description": "' + description + '",' +
        artifact + ',' +
        variables + ',' +
        '"isDraft": false,' +
        '"reason": "none",' +
        '"manualEnvironments": ["' + manualEnvironments + '"]}';
}

async function CreateReleaseAsync(headers: Headers, projectName: string, releaseName: string, attributes: { [id: string]: string }, userDefinedEnvironment: string): Promise<number> {

    headers.set('Content-Type', 'application/json');
    let definitionId = await GetDefinitionIdAsync(headers, projectName, releaseName);
    let buildArtifact = await GetBuildArtifactAsync(headers, projectName, definitionId);
    let environments = await GetEnvironmentsAsync(headers, projectName, definitionId, userDefinedEnvironment);
    let releaseBody = CreateReleaseBody(definitionId, environments, buildArtifact, attributes);
    return fetch('https://vsrm.dev.azure.com/beslistnl/' + projectName + '/_apis/release/releases?api-version=5.0',
        {
            headers: headers,
            method: 'POST',
            body: releaseBody
        }).then(function (response) {
            if (response.ok) {
                return response.json();
            }
            throw Error(response.statusText);
        }).then(function (jsonResult) {
            return jsonResult.id;
        });
}

async function WaitForReleaseToFinishAsync(headers: Headers, projectName: string, releaseId: number, userDefinedEnvironment: string) {

    let finished = false;
    let uri = 'https://vsrm.dev.azure.com/beslistnl/' + projectName + '/_apis/release/releases/' + releaseId + '?api-version=5.0';
    while (!finished) {
        finished = await fetch(uri,
            {
                headers: headers,
                method: 'GET'
            }).then(function (response) {
                if (response.ok) {
                    return response.json();
                }
                throw Error(response.statusText);
            }).then(function (jsonResult) {
                return jsonResult.environments.foreach(async function (environment: any) {
                    if (environment.name == userDefinedEnvironment) {
                        let status = environment.status;
                        if (status == 'notStarted') {
                            await StartNotStartedEnvironmentAsync(headers, projectName, releaseId, userDefinedEnvironment);
                        }
                        else if (status != 'canceled' && status != 'partiallySucceeded' && status != 'rejected' && status != 'succeeded') {
                            await delay(3000);
                        }
                        else {
                            return true;
                        }
                    }
                    return false;
                });
            });
    }
}

async function GetReleaseEnvironmentIdAsync(headers: Headers, projectName: string, releaseId: number, userDefinedEnvironment: string): Promise<number> {

    return fetch('https://vsrm.dev.azure.com/beslistnl/' + projectName + '/_apis/release/releases/' + releaseId + '?api-version=5.0',
        {
            headers: headers,
            method: 'GET'
        }).then(function (response) {
            if (response.ok) {
                return response.json();
            }
            throw Error(response.statusText);
        }).then(function (jsonResult) {
            return jsonResult.environments.foreach(function (environment: any) {
                if (environment == userDefinedEnvironment) {
                    return environment.id;
                }
            });
        });
}

async function StartNotStartedEnvironmentAsync(headers: Headers, projectName: string, releaseId: number, userDefinedEnvironment: string) {

    headers.set('Content-Type', 'application/json');
    let environmentId = await GetReleaseEnvironmentIdAsync(headers, projectName, releaseId, userDefinedEnvironment);
    let releaseBody = '{"status": "inProgress",' +
        '"scheduledDeploymentTime": null,' +
        '"comment": "triggered by integration test"}';
    await fetch('https://vsrm.dev.azure.com/beslistnl/' + projectName + '/_apis/release/releases/' + releaseId + '/environments/' + environmentId + '?api-version=5.1-preview.6',
        {
            headers: headers,
            method: 'PATCH',
            body: releaseBody
        }).then(async function (response) {
            if (response.ok) {
                await delay(3000);
            }
            throw Error(response.statusText);
        });
}

async function run() {
    try {
        const projectName: string = taskLib.getInput('ProjectName', true);
        const releaseName: string = taskLib.getInput('ReleaseName', true);
        //const artifactEnvironment: string = taskLib.getInput('ArtifactEnvironment', true);
        //const environment: string = taskLib.getInput('Environment', true);
        const personalAccesToken: string = taskLib.getInput('personalAccesToken', true);
        const attributes: { [id: string]: string } = {};//taskLib.getInput('Attributes', true);
        let token = Buffer.from(':' + personalAccesToken).toString('base64')
        let headers: Headers = new Headers();
        headers.set('Authorization', 'Basic ' + token);
        // let releaseId = await CreateReleaseAsync(headers, projectName, releaseName, attributes, environment);
        // await WaitForReleaseToFinishAsync(headers, projectName, releaseId, environment);
        headers.set('Content-Type', 'application/json');
        let definitionId = await GetDefinitionIdAsync(headers, projectName, releaseName);
        let buildArtifact = await GetBuildArtifactAsync(headers, projectName, definitionId);
        console.log(definitionId);
        console.log(buildArtifact);
    }
    catch (err) {
        taskLib.setResult(taskLib.TaskResult.Failed, err.message);
    }
}

run();