import { runFileReadPipeline } from './pipelines';

export async function onRequest(context: any) {
  return runFileReadPipeline(context);
}
