import * as taskLib from 'azure-pipelines-task-lib/task';
import { delay } from 'q';

import * as lim from "azure-devops-node-api/interfaces/LocationsInterfaces";
import * as nodeApi from 'azure-devops-node-api';
import * as ReleaseApi from 'azure-devops-node-api/ReleaseApi';
import * as ReleaseInterfaces from 'azure-devops-node-api/interfaces/ReleaseInterfaces';

async function GetBuildArtifactAsync(releaseApiObject: ReleaseApi.IReleaseApi, projectName: string, releaseDefinitionId: number, artifactEnvironmentId: number): Promise<ReleaseInterfaces.ArtifactMetadata[]> {
    var deployments: ReleaseInterfaces.Deployment[] = await releaseApiObject.getDeployments(projectName, releaseDefinitionId, artifactEnvironmentId, undefined, undefined, undefined, ReleaseInterfaces.DeploymentStatus.Succeeded, undefined, undefined, ReleaseInterfaces.ReleaseQueryOrder.Descending);
    if (deployments.length == 0) {
        return []
        //get latest build or something
    }
    else {
        let release = deployments[0].release;
        if (release && release.artifacts) {
            return release.artifacts.map(function(artifact : ReleaseInterfaces.Artifact){
                let artifactMetaData : ReleaseInterfaces.ArtifactMetadata = {};
                artifactMetaData.alias = artifact.alias;
                if(artifact.definitionReference){
                    let instanceReference : ReleaseInterfaces.BuildVersion = {};
                    instanceReference.id = artifact.definitionReference['version'].id
                    instanceReference.name = artifact.definitionReference['version'].name
                    artifactMetaData.instanceReference = instanceReference;
                }
                return artifactMetaData;
            });
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
                x.push(environment.name);
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

async function CreateReleaseAsync(releaseApiObject: ReleaseApi.IReleaseApi, projectName: string, releaseDefinitionId: number, artifactEnvironmentId: number, releaseEnvironmentId: number, attributes: { [id: string]: string }): Promise<ReleaseInterfaces.Release> {

    let buildArtifact = await GetBuildArtifactAsync(releaseApiObject, projectName, releaseDefinitionId, artifactEnvironmentId);
    let manualEnvironments = await GetEnvironmentsAsync(releaseApiObject, projectName, releaseDefinitionId, releaseEnvironmentId);
    let releaseBody = CreateReleaseBody(releaseDefinitionId, manualEnvironments, buildArtifact, attributes);
    return await releaseApiObject.createRelease(releaseBody, projectName)
}

async function WaitForReleaseToFinishAsync(releaseApiObject: ReleaseApi.IReleaseApi, projectName: string, release: ReleaseInterfaces.Release, releaseEnvironmentId: number) {

    let finished = false;
    while (!finished) {
        if(release.id){
            let releaseId : number = release.id;
            var releaseStatus = await releaseApiObject.getRelease(projectName, release.id);
            if(releaseStatus.environments){
                finished = await releaseStatus.environments.reduce(async function (x: Promise<boolean>, environment: ReleaseInterfaces.ReleaseEnvironment) {
                    if (environment.definitionEnvironmentId == releaseEnvironmentId) {
                        let status = environment.status;
                        if (status == ReleaseInterfaces.EnvironmentStatus.NotStarted) {
                            await StartNotStartedEnvironmentAsync(releaseApiObject, projectName, releaseId, GetReleaseEnvironmentId(release, releaseEnvironmentId));
                        }
                        else if (status != ReleaseInterfaces.EnvironmentStatus.Canceled && 
                            status != ReleaseInterfaces.EnvironmentStatus.PartiallySucceeded && 
                            status != ReleaseInterfaces.EnvironmentStatus.Rejected && 
                            status != ReleaseInterfaces.EnvironmentStatus.Succeeded) {
                            await delay(3000);
                        }
                        else {
                            x = new Promise<boolean>(resolve => true);
                        }
                    }
                    return x;
                }, new Promise<boolean>(resolve => false));
            }
        }
    }
}

function GetReleaseEnvironmentId(release: ReleaseInterfaces.Release, releaseEnvironmentId: number) : number {
    if (release.environments) {
        let result = release.environments.reduce(function (x: number | undefined, environment: ReleaseInterfaces.ReleaseEnvironment) {
            if (environment.definitionEnvironmentId == releaseEnvironmentId) {
                x = environment.id;
            }
            return x;
        }, undefined);
        if (result) {
            return result;
        }
    }
    throw Error("no id found"); 
}

async function StartNotStartedEnvironmentAsync(releaseApiObject: ReleaseApi.IReleaseApi, projectName: string, releaseId: number, releaseEnvironmentId: number): Promise<ReleaseInterfaces.ReleaseEnvironment> { 
    let environmentUpdateData: ReleaseInterfaces.ReleaseEnvironmentUpdateMetadata = {}
    environmentUpdateData.status = ReleaseInterfaces.EnvironmentStatus.InProgress;
    environmentUpdateData.scheduledDeploymentTime = undefined;
    environmentUpdateData.comment = "triggered by integration test";
    return await releaseApiObject.updateReleaseEnvironment(environmentUpdateData,projectName, releaseId, releaseEnvironmentId);
}

async function getWebApi(serverUrl?: string): Promise<nodeApi.WebApi> {
    serverUrl = serverUrl || taskLib.getVariable("System.TeamFoundationCollectionUri");
    return await getApi(serverUrl);
}

async function getApi(serverUrl: string): Promise<nodeApi.WebApi> {
    return new Promise<nodeApi.WebApi>(async (resolve, reject) => {
        try {
            // let serverCreds: string = taskLib.getInput('token', true);
            // let authHandler = nodeApi.getPersonalAccessTokenHandler(serverCreds);
            let serverCreds: string = taskLib.getEndpointAuthorizationParameter('SYSTEMVSSCONNECTION', 'ACCESSTOKEN', false);
            let authHandler = nodeApi.getPersonalAccessTokenHandler(serverCreds);
            let option = undefined;
            // let token = taskLib.getVariable('System.AccessToken');
            // let personalAccessToken = nodeApi.getPersonalAccessTokenHandler(token);
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
        const artifactEnvironmentId: number = Number(taskLib.getInput('ArtifactEnvironmentId', true));
        const attributes: { [id: string]: string } = JSON.parse(taskLib.getInput('Attributes', true));
        const webApi: nodeApi.WebApi = await getWebApi();

        const releaseApiObject: ReleaseApi.IReleaseApi = await webApi.getReleaseApi();
        let release = await CreateReleaseAsync(releaseApiObject, projectName, releaseId, artifactEnvironmentId, releaseEnvironmentId, attributes);
        console.log(release);
        await WaitForReleaseToFinishAsync( releaseApiObject, projectName,release, releaseEnvironmentId);
        // example inputs {projectName: webshops offer, releaseId:23, releaseEnvironmentId: 69,artifactEnvironmentId:68, Attributes: {}}
    }
    catch (err) {
        taskLib.setResult(taskLib.TaskResult.Failed, err.message);
    }
}

run();