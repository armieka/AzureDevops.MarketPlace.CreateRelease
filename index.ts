import * as taskLib from 'azure-pipelines-task-lib/task';

async function run() {
    try {
        const inputString: string = taskLib.getInput('samplestring', true);
        if (inputString == 'bad') {
            taskLib.setResult(taskLib.TaskResult.Failed, 'Bad input was given');
            return;
        }
        console.log('Hello', inputString);
    }
    catch (err) {
        taskLib.setResult(taskLib.TaskResult.Failed, err.message);
    }
}

run();