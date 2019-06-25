import * as taskLib from 'azure-pipelines-task-lib/task';
import "isomorphic-fetch";

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

async function GetEnvironments(headers: HeadersInit, projectName: string, definitionId: number, environmentName: string): Promise<string> {

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
             let environments = jsonResult.environments.map(function (environment: any) {
                if(environment.name != environmentName){
                    return '\"' + environment.name + '\"';
                }
            }).reduce(function (x: string, y: string) {
                if(y){
                    return x + ',' + y;
                }
                return x;
            });
            return (environments) ? environments : '';
        });
}

async function run() {
    try {
        const projectName: string = taskLib.getInput('ProjectName', true);
        const releaseName: string = taskLib.getInput('ReleaseName', true);
        //const artifactEnvironment: string = taskLib.getInput('ArtifactEnvironment', true);
        const environment: string = taskLib.getInput('Environment', true);
        //const attributes: string = taskLib.getInput('Attributes', true);
        let token = Buffer.from(':').toString('base64')
        let headers: any = { 'Authorization': 'Basic ' + token };
        let definitionId = await GetDefinitionIdAsync(headers, projectName, releaseName);
        let environments = await GetEnvironments(headers, projectName, definitionId, environment);
        console.log(environments);
    }
    catch (err) {
        taskLib.setResult(taskLib.TaskResult.Failed, err.message);
    }
}

run();