import { runAsWorker } from "synckit";

runAsWorker(async (params) => {
    console.log(params);
});