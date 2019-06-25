Import-Module .\ps_modules\VstsTaskSdk

Function GetDefinitionId([System.Collections.Generic.Dictionary[[String], [String]]] $headers, [String] $projectName, [String] $releaseName) {
    $uri = 'https://vsrm.dev.azure.com/beslistnl/'+$projectName+'/_apis/release/definitions?api-version=5.0&searchText='+$releaseName+'&isExactNameMatch=true'
    $getReleaseDefinitionsResponse = Invoke-WebRequest -Uri $uri -Method 'GET' -Headers $headers  
    $releaseDefinitions = ConvertFrom-Json $getReleaseDefinitionsResponse
    if (1 -ne $releaseDefinitions.count) {
        $ErrorActionPreference = 'to many release definitions'
        exit
    }
    $definitionId = $releaseDefinitions.value[0].id
    return $definitionId
}

Function GetEnvironments([System.Collections.Generic.Dictionary[[String], [String]]] $headers, [String] $definitionId, [String] $projectName, [String] $environment) {
    $uri = 'https://vsrm.dev.azure.com/beslistnl/'+$projectName+'/_apis/Release/definitions/' + $definitionId + '?api-version=5.0'
    $getReleaseDefinitionResponse = Invoke-WebRequest -UseBasicParsing -Uri $uri -Method 'GET' -Headers $headers
    
    $environmentsFromResponse = ($getReleaseDefinitionResponse | ConvertFrom-Json).environments
    
    $environmentNames = @()
    foreach ($env in $environmentsFromResponse) {
        $environmentName = $env.name
        $environmentNames += , $environmentName
    }
    $manualEnvironments = $environmentNames | Where-Object { $_ -ne $environment }
    $manualEnvironments = $manualEnvironments -join '","'
    return $manualEnvironments
}

Function GetBuildArtifact([System.Collections.Generic.Dictionary[[String], [String]]] $headers, [String] $definitionId, [String] $projectName) {
    $uri = 'https://vsrm.dev.azure.com/beslistnl/'+$projectName+'/_apis/release/deployments?api-version=5.0&query+Order=descending&deploymentStatus=succeeded&definitionId=' + $definitionId
    try {
        $getReleaseDeploymentResponse = Invoke-WebRequest -UseBasicParsing -Uri $uri -Method 'GET' -Headers $headers
        $releaseDeployments = ConvertFrom-Json $getReleaseDeploymentResponse 
        foreach ($releaseDeployment in $releaseDeployments.value) {
            if ($releaseDeployment.releaseEnvironment.name -eq 'Production') {
                foreach ($artifact in $releaseDeployment.release.artifacts) {
                    if ($artifact.alias.ToLower() -notlike '*test*') {
                        $alias = $artifact.alias
                        $name = $artifact.definitionReference.version.name
                        $id = $artifact.definitionReference.version.id
                        return '"artifacts": [
                            {
                                "alias": "' + $alias + '",
                                "instanceReference": {
                                    "id": "' + $id + '",
                                    "name": "' + $name + '"
                                }
                            }
                        ]'
                    }
                }
            }
        }
    }
    catch {
        $ErrorActionPreference = $_.Exception.Message
        exit
    }
}

Function CreateReleaseBody([String[]] $manualEnvironments, [String] $Artifact, [String] $definitionId, [System.Collections.Generic.Dictionary[[String], [String]]] $attributes) {
    $variables = '"variables": {'
    foreach ($attribute in $attributes.keys) {
        $variables += '"' + $attribute + '":{"value":"' + $attributes[$attribute] + '"},'
    }
    if ($variables.EndsWith(',')) {
        $variables = $variables.Substring(0, $variables.Length - 1)
    }
    $variables += '}'
    $description = 'triggered by integration test'
    return '{
	"definitionId": '+$definitionId+',
	"description":  "' + $description + '",
	' + $Artifact +',
	' + $variables + ',
	"isDraft": false,
	"reason": "none",
	"manualEnvironments": ["' + $manualEnvironments + '"]
}' 
}
Function CreateRelease([System.Collections.Generic.Dictionary[[String], [String]]] $headers, [String] $projectName, [String] $releaseName, [System.Collections.Generic.Dictionary[[String], [String]]] $attributes, [String] $userDefinedEnvironment) {
    $definitionId = GetDefinitionId $headers $projectName $releaseName
    $buildArtifact = GetBuildArtifact $headers $definitionId $projectName
    $environments = GetEnvironments $headers $definitionId $projectName
    $releaseBody = CreateReleaseBody $environments $buildArtifact $definitionId $attributes $userDefinedEnvironment
    try {
        $uri = 'https://vsrm.dev.azure.com/beslistnl/'+$projectName+'/_apis/release/releases?api-version=5.0'
        $createReleaseResponse = Invoke-WebRequest -UseBasicParsing -Uri $uri -Method 'POST' -Body $releaseBody -ContentType "application/json" -Headers $headers
        $createReleaseResult = ConvertFrom-Json $createReleaseResponse
        $releaseId = $createReleaseResult.id 
        return $releaseId
    }
    catch {
        $ErrorActionPreference = $_.Exception.Message
        exit
    }
}

Function WaitForReleaseToFinish([System.Collections.Generic.Dictionary[[String], [String]]] $headers, [String] $releaseId, [String] $projectName, [String] $userDefinedEnvironment) {
    try {
        $uri = 'https://vsrm.dev.azure.com/beslistnl/'+$projectName+'/_apis/release/releases/' + $releaseId + '?api-version=5.0'
        $finished = $false
        while (-not $finished) {
            $getReleaseStatusResponse = Invoke-WebRequest -UseBasicParsing -Uri $uri -Method 'GET' -Headers $headers
            $getReleaseStatusResult = ConvertFrom-Json $getReleaseStatusResponse
            foreach ($environment in $getReleaseStatusResult.environments) {
                if ($environment.name -eq $environment) {
                    if ($environment.status -eq 'notStarted') { 
                        StartNotStartedEnvironment $headers $releaseId $environmentId $userDefinedEnvironment
                    }
                    elseif ($environment.status -ne 'canceled' -and $environment.status -ne 'partiallySucceeded' -and $environment.status -ne 'rejected' -and $environment.status -ne 'succeeded') {
                        sleep 3
                    }
                    else {
                        $finished = $true
                    }
                }
            }
        }
    }
    catch {
        $ErrorActionPreference = $_.Exception.Message
    }
}

Function GetReleaseEnvironmentId([System.Collections.Generic.Dictionary[[String], [String]]] $headers, [int] $releaseId, [String] $projectName, [String] $userDefinedEnvironment) {
    $uriDefinitionList = 'https://vsrm.dev.azure.com/beslistnl/'+$projectName+'/_apis/release/releases/' + $releaseId + '?api-version=5.0'
    $getReleaseDefinitionsResponse = Invoke-WebRequest -UseBasicParsing -Uri $uriDefinitionList -Method 'GET' -Headers $headers
    $releaseDefinitions = ConvertFrom-Json $getReleaseDefinitionsResponse
    foreach ($env in $releaseDefinitions.environments) {
        if ($env.name -eq $userDefinedEnvironment) {
            $environmentId = $env.id
            return $environmentId
        }
    }
}

Function StartNotStartedEnvironment([System.Collections.Generic.Dictionary[[String], [String]]] $headers, [int] $releaseId, [String] $projectName, [String] $userDefinedEnvironment) {
    $environmentId = GetReleaseEnvironmentId $headers $releaseId $userDefinedEnvironment
    $uri = 'https://vsrm.dev.azure.com/beslistnl/'+$projectName+'/_apis/release/releases/' + $releaseId + '/environments/' + $environmentId + '?api-version=5.1-preview.6'
    $releaseBody = '{
    "status": "inProgress",
    "scheduledDeploymentTime": null,
    "comment": "triggered by integration test"
}'
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $uri -Method 'PATCH' -Headers $headers  -Body $releaseBody  -ContentType "application/json"
        sleep 3
    }
    catch {
        $ErrorActionPreference = $_.Exception.Message
        exit
    }
}

$projectName = Get-VstsInput -Name 'projectName'
$releaseName = Get-VstsInput -Name 'releaseName'
$userDefinedEnvironment = Get-VstsInput -Name 'environment'
$variables = Get-VstsInput -Name 'variables'

$headers = New-Object "System.Collections.Generic.Dictionary[[String],[String]]"
$personalAccessToken = ''
$token = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes(':' + $personalAccessToken))
$headers.Add('Authorization', 'Basic ' + $token)
$releaseId = CreateRelease $headers $projectName $releaseName @{} $userDefinedEnvironment
WaitForReleaseToFinish $headers $releaseId $projectName