import * as taskLib from 'azure-pipelines-task-lib/task';
import "isomorphic-fetch";
import { delay } from 'q';

import * as lim from "azure-devops-node-api/interfaces/LocationsInterfaces";
import * as nodeApi from 'azure-devops-node-api';
import * as ReleaseApi from 'azure-devops-node-api/ReleaseApi';
import * as ReleaseInterfaces from 'azure-devops-node-api/interfaces/ReleaseInterfaces';

async function GetBuildArtifactAsync(releaseApiObject: ReleaseApi.IReleaseApi, projectName: string, releaseDefinitionId: number, releaseEnvironmentId: number): Promise<ReleaseInterfaces.ArtifactMetadata[]> {
    var deployments: ReleaseInterfaces.Deployment[] = await releaseApiObject.getDeployments(projectName, releaseDefinitionId, releaseEnvironmentId, undefined, undefined, undefined, ReleaseInterfaces.DeploymentStatus.Succeeded, undefined, undefined, ReleaseInterfaces.ReleaseQueryOrder.Descending);
    var artifacts: ReleaseInterfaces.ArtifactMetadata[] = [];
    if (deployments.length == 0) {
        return []
        //get latest build or something
    }
    else {
        let release = deployments[0].release;
        if (release && release.artifacts && release.artifacts.length > 0) {
            return release.artifacts;
        }
    }
    return [];

}

async function GetEnvironmentsAsync(releaseApiObject: ReleaseApi.IReleaseApi, projectName: string, releaseDefinitionId: number, releaseEnvironmentId: number): Promise<string[]> {

    let releaseDefinition: ReleaseInterfaces.ReleaseDefinition = await releaseApiObject.getReleaseDefinition(projectName, releaseDefinitionId);
    let releaseEnvironments = releaseDefinition.environments;
    if (releaseEnvironments && releaseEnvironments.length > 0) {
        return releaseEnvironments.reduce(function (x: string[], environment: any) {
            if (environment.id != releaseEnvironmentId) {
                x.push('\"' + environment.name + '\"');
            }
            return x;
        }, []);
    }
    return [];
}


function CreateReleaseBody(definitionId: number, manualEnvironments: string[], artifacts: ReleaseInterfaces.ArtifactMetadata[], attributes: { [id: string]: string }): ReleaseInterfaces.ReleaseStartMetadata {

    let releaseStartMetaData: ReleaseInterfaces.ReleaseStartMetadata = {};

    releaseStartMetaData.description = 'triggered by integration test';
    releaseStartMetaData.definitionId = definitionId;
    releaseStartMetaData.isDraft = false;
    releaseStartMetaData.manualEnvironments = manualEnvironments;
    releaseStartMetaData.artifacts = artifacts
    releaseStartMetaData.reason = ReleaseInterfaces.ReleaseReason.None;
    releaseStartMetaData.variables = Object.keys(attributes).reduce(function (x: { [key: string]: ReleaseInterfaces.ConfigurationVariableValue }, id: string) {
        let configurationVariable: ReleaseInterfaces.ConfigurationVariableValue = {}
        configurationVariable.value = attributes[id];
        x[id] = configurationVariable;
        return x;
    }, {});
    return releaseStartMetaData;
}

async function CreateReleaseAsync(releaseApiObject: ReleaseApi.IReleaseApi, projectName: string, releaseDefinitionId: number, releaseEnvironmentId: number, attributes: { [id: string]: string }): Promise<ReleaseInterfaces.Release> {

    let buildArtifact = await GetBuildArtifactAsync(releaseApiObject, projectName, releaseDefinitionId, releaseEnvironmentId);
    console.log(buildArtifact);
    let manualEnvironments = await GetEnvironmentsAsync(releaseApiObject, projectName, releaseDefinitionId, releaseEnvironmentId);
    console.log(manualEnvironments);
    let releaseBody = CreateReleaseBody(releaseDefinitionId, manualEnvironments, buildArtifact, attributes);
    console.log(releaseBody);
    return await releaseApiObject.createRelease(releaseBody, projectName)
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
            //let serverCreds: string = taskLib.getEndpointAuthorizationParameter('SYSTEMVSSCONNECTION', 'ACCESSTOKEN', false);
            //let authHandler = nodeApi.getPersonalAccessTokenHandler(serverCreds);
            let option = undefined;
            let token = taskLib.getVariable('System.AccessToken');
            let personalAccessToken = nodeApi.getPersonalAccessTokenHandler(token);
            console.log(personalAccessToken);
            let vsts: nodeApi.WebApi = new nodeApi.WebApi(serverUrl, personalAccessToken, option);
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
        const releaseDefinitionId: number = Number(taskLib.getInput('ReleaseId', true));
        const releaseEnvironmentId: number = Number(taskLib.getInput('ReleaseEnvironmentId', true));
        const webApi: nodeApi.WebApi = await getWebApi();

        const releaseApiObject: ReleaseApi.IReleaseApi = await webApi.getReleaseApi();
        let release = await CreateReleaseAsync(releaseApiObject, projectName, releaseDefinitionId, releaseEnvironmentId, {});
        console.log(release);

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