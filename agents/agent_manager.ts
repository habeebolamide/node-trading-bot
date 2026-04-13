
import { Agent } from "../generated/prisma/client";
import { prisma } from "../lib/prisma";
import logger from "../utils/logger";

export class AgentManager {

    public async loadAgents(): Promise<Agent[]> {
        const dbAgents = await prisma.agent.findMany({
            where: { status: 'active' },
        });

        return dbAgents;
    }
}