import { runFileReadPipeline } from './_pipelines';

export async function onRequest(context: any) {
  return runFileReadPipeline(context);
}
