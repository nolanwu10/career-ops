import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { EnrichmentOutputSchema, type EnrichmentOutput } from '@career-ops/shared-types';
import type { RecommendationEnricher } from './enrichment-service.js';

export class BedrockRecommendationEnricher implements RecommendationEnricher {
  constructor(
    private readonly client: BedrockRuntimeClient,
    private readonly modelId: string
  ) {}

  async enrich({ job, profile, recommendation }: Parameters<RecommendationEnricher['enrich']>[0]): Promise<EnrichmentOutput> {
    const response = await this.client.send(new ConverseCommand({
      modelId: this.modelId,
      system: [{
        text: 'You explain job recommendations using only supplied job data and approved candidate evidence. Return strict JSON with strongMatches, concerns, and applicationAngles arrays. Never invent experience.'
      }],
      messages: [{
        role: 'user',
        content: [{
          text: JSON.stringify({
            job: {
              company: job.company,
              title: job.title,
              description: job.description.slice(0, 30_000),
              locations: job.locations,
              workMode: job.workMode,
              compensation: job.compensation
            },
            approvedProfile: {
              targetRoles: profile.targetRoles,
              skills: profile.skills,
              evidenceKeywords: profile.evidenceKeywords,
              careerGoals: profile.careerGoals,
              targetLocations: profile.targetLocations
            },
            deterministicAssessment: {
              fitScore: recommendation.fitScore,
              strongMatches: recommendation.strongMatches,
              concerns: recommendation.concerns
            }
          })
        }]
      }],
      inferenceConfig: {
        maxTokens: 1_200,
        temperature: 0.1
      }
    }));
    const text = response.output?.message?.content
      ?.map((block) => 'text' in block ? block.text : '')
      .join('')
      .trim();
    if (!text) throw new Error('Bedrock returned no enrichment text.');
    return EnrichmentOutputSchema.parse(JSON.parse(extractJson(text)));
  }
}

function extractJson(value: string): string {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) return fenced.trim();
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start >= 0 && end > start) return value.slice(start, end + 1);
  return value;
}
