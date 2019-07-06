import * as taskLib from 'azure-pipelines-task-lib/task';
import "isomorphic-fetch";
import { delay } from 'q';

import * as lim from "azure-devops-node-api/interfaces/LocationsInterfaces";
import * as nodeApi from 'azure-devops-node-api';
import * as ReleaseApi from 'azure-devops-node-api/ReleaseApi';
import * as ReleaseInterfaces from 'azure-devops-node-api/interfaces/ReleaseInterfaces';

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
    let result = await fetch('https://vsrm.dev.azure.com/beslistnl/' + projectName + '/_apis/release/deployments?api-version=5.0&query+Order=descending&deploymentStatus=succeeded&definitionId=' + definitionId,
        {
            headers: headers,
            method: 'GET'
        }).then(function (response) {
            if (response.ok) {
                return response.json();
            }
            throw Error(response.statusText);
        }).then(function (jsonResult) {
            let result: { [name: string]: string } = jsonResult.value.reduce(function (artifacts: { [name: string]: string }, deploymentType: any) {
                artifacts[deploymentType.releaseEnvironment.name] = '"artifacts": [' + deploymentType.release.artifacts.map(function (artifact: any) {
                    return '{ "alias": "' + artifact.alias + '",' +
                        '"instanceReference": {' +
                        '"name": "' + artifact.definitionReference.version.name + '",' +
                        '"id": "' + artifact.definitionReference.version.id + '"}' +
                        '}';
                }).join(',') + ']';
                return artifacts;
            }, {});
            return result;
        });
    return result[Object.keys(result)[0]] ? result[Object.keys(result)[0]] : "\"artifacts\": []";//return specified environment
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
            return jsonResult.environments.reduce(function (x: string[], environment: any) {
                if (environment.name != environmentName) {
                    x.push('\"' + environment.name + '\"');
                }
                return x;
            }, []).join(',');
        });
}


function CreateReleaseBody(definitionId: number, manualEnvironments: string, artifact: string, attributes: { [id: string]: string }): string {

    let variables = '"variables": {' + Object.keys(attributes).reduce(function (x: string[], id: string) {
        x.push('"' + id + '":{"value":"' + attributes[id] + '"}');
        return x;
    }, []).join(',') + '}';
    let description = 'triggered by integration test';
    return '{"definitionId": ' + definitionId + ',' +
        '"description": "' + description + '",' +
        artifact + ',' +
        variables + ',' +
        '"isDraft": false,' +
        '"reason": "none",' +
        '"manualEnvironments": [' + manualEnvironments + ']}';
}

async function CreateReleaseAsync(headers: Headers, projectName: string, releaseName: string, attributes: { [id: string]: string }, userDefinedEnvironment: string): Promise<number> {

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
                return jsonResult.environments.reduce(async function (x: boolean, environment: any) {
                    if (environment.name == userDefinedEnvironment) {
                        let status = environment.status;
                        if (status == 'notStarted') {
                            await StartNotStartedEnvironmentAsync(headers, projectName, releaseId, userDefinedEnvironment);
                        }
                        else if (status != 'canceled' && status != 'partiallySucceeded' && status != 'rejected' && status != 'succeeded') {
                            await delay(3000);
                        }
                        else {
                            x = true;
                        }
                    }
                    return x;
                }, false);
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
            return jsonResult.environments.reduce(function (x: { [id: string]: string }, environment: any) {
                x[environment.name] = environment.id;
                return x;
            }, {})[userDefinedEnvironment];
        });
}

async function StartNotStartedEnvironmentAsync(headers: Headers, projectName: string, releaseId: number, userDefinedEnvironment: string) {

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
                return;
            }
            throw Error(response.statusText);
        });
}

async function getWebApi(serverUrl?: string): Promise<nodeApi.WebApi> {
    serverUrl = serverUrl || taskLib.getInput("SYSTEM_TEAMFOUNDATIONCOLLECTIONURI");
    console.log('url');
    console.log(serverUrl);
    return await getApi(serverUrl);
}

async function getApi(serverUrl: string): Promise<nodeApi.WebApi> {
    return new Promise<nodeApi.WebApi>(async (resolve, reject) => {
        try {
            let token = taskLib.getInput("System.AccessToken");
            console.log('token');
            console.log(token);
            let authHandler = nodeApi.getBearerHandler(token);
            let option = undefined;

            let vsts: nodeApi.WebApi = new nodeApi.WebApi(serverUrl, authHandler, option);
            let connData: lim.ConnectionData = await vsts.connect();
            console.log(connData);
            resolve(vsts);
        }
        catch (err) {
            reject(err);
        }
    });
}

async function run() {
    try {
        const projectName: string = taskLib.getInput('ProjectName', true);
        const releaseId: number = Number(taskLib.getInput('ReleaseId', true));
        const webApi: nodeApi.WebApi = await getWebApi();
        const releaseApiObject: ReleaseApi.IReleaseApi = await webApi.getReleaseApi();
        var deployments : ReleaseInterfaces.Deployment[] = await releaseApiObject.getDeployments(projectName, releaseId);
        console.log(deployments[0])
        // //const artifactEnvironment: string = taskLib.getInput('ArtifactEnvironment', true);
        // const userDefinedEnvironment: string = taskLib.getInput('Environment', true);
        // const personalAccessToken: string = taskLib.getInput('PersonalAccessToken', true);
        // const attributes: { [id: string]: string } = JSON.parse(taskLib.getInput('Attributes', true));
        // let token = Buffer.from(':' + personalAccessToken).toString('base64')
        // let headers: Headers = new Headers();
        // headers.set('Authorization', 'Basic ' + token);
        // headers.set('Content-Type', 'application/json');
        // let releaseId = await CreateReleaseAsync(headers, projectName, releaseName, attributes, userDefinedEnvironment);
        // await WaitForReleaseToFinishAsync(headers, projectName, releaseId, userDefinedEnvironment);

    }
    catch (err) {
        taskLib.setResult(taskLib.TaskResult.Failed, err.message);
    }
}

run();