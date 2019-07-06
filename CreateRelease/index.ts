import * as taskLib from 'azure-pipelines-task-lib/task';
import "isomorphic-fetch";
import { delay } from 'q';

import * as lim from "azure-devops-node-api/interfaces/LocationsInterfaces";
import * as nodeApi from 'azure-devops-node-api';
import * as ReleaseApi from 'azure-devops-node-api/ReleaseApi';
import * as ReleaseInterfaces from 'azure-devops-node-api/interfaces/ReleaseInterfaces';

async function GetBuildArtifactAsync(releaseApiObject: ReleaseApi.IReleaseApi, projectName: string, releaseId: number, releaseEnvironmentId: number): Promise<string> {
    var deployments: ReleaseInterfaces.Deployment[] = await releaseApiObject.getDeployments(projectName, releaseId, releaseEnvironmentId, undefined, undefined, undefined, ReleaseInterfaces.DeploymentStatus.Succeeded, undefined, undefined, ReleaseInterfaces.ReleaseQueryOrder.Descending);
    var artifacts = '"artifacts": [';
    if (deployments.length == 0) {
        //get latest build or something
    }
    else {
        let release = deployments[0].release;
        if (release && release.artifacts && release.artifacts.length > 0) {
            artifacts += release.artifacts.reduce(function (result: string[], artifact: ReleaseInterfaces.Artifact) {
                let definitionReference = artifact.definitionReference;
                if (definitionReference) {
                    result.push('{ "alias": "' + artifact.alias + '",' +
                        '"instanceReference": {' +
                        '"name": "' + definitionReference.version.name + '",' +
                        '"id": "' + definitionReference.version.id + '"}' +
                        '}');
                }
                return result;
            }, []).join(',');
        }
        artifacts += ']';
    }
    return artifacts;

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

async function CreateReleaseAsync(releaseApiObject: ReleaseApi.IReleaseApi, projectName: string, releaseId: number, releaseEnvironmentId: number): Promise<number> {

    let buildArtifact = await GetBuildArtifactAsync(releaseApiObject, projectName, releaseId, releaseEnvironmentId);
    // let environments = await GetEnvironmentsAsync(headers, projectName, definitionId, userDefinedEnvironment);
    // let releaseBody = CreateReleaseBody(definitionId, environments, buildArtifact, attributes);
    return 1;
    // return fetch('https://vsrm.dev.azure.com/beslistnl/' + projectName + '/_apis/release/releases?api-version=5.0',
    //     {
    //         headers: headers,
    //         method: 'POST',
    //         body: releaseBody
    //     }).then(function (response) {
    //         if (response.ok) {
    //             return response.json();
    //         }
    //         throw Error(response.statusText);
    //     }).then(function (jsonResult) {
    //         return jsonResult.id;
    //     });
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
    serverUrl = serverUrl || taskLib.getVariable("System.TeamFoundationCollectionUri");
    return await getApi(serverUrl);
}

async function getApi(serverUrl: string): Promise<nodeApi.WebApi> {
    return new Promise<nodeApi.WebApi>(async (resolve, reject) => {
        try {
            let serverCreds: string = taskLib.getEndpointAuthorizationParameter('SYSTEMVSSCONNECTION', 'ACCESSTOKEN', false);
            let authHandler = nodeApi.getPersonalAccessTokenHandler(serverCreds);
            let option = undefined;

            let vsts: nodeApi.WebApi = new nodeApi.WebApi(serverUrl, authHandler, option);
            let connData: lim.ConnectionData = await vsts.connect();
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
        const releaseEnvironmentId: number = Number(taskLib.getInput('ReleaseEnvironmentId', true));
        const webApi: nodeApi.WebApi = await getWebApi();

        const releaseApiObject: ReleaseApi.IReleaseApi = await webApi.getReleaseApi();
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