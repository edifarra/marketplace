import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { CLAIM_ACTION_LABELS,ClaimAction,ClaimError } from "@/lib/marketplace-claim-domain";
import { prepareClaimAction,queueClaimOperation,readClaimReturnCost } from "@/lib/marketplace-claim-service";
import { z } from "zod";
export const dynamic="force-dynamic";
const body=z.object({operationId:z.string().uuid(),context:z.record(z.unknown()),token:z.string().length(64),parameters:z.object({message:z.string().trim().min(1).max(4000).optional(),offer:z.object({percentage:z.number().gt(0).lt(100),amount:z.number().positive(),currency:z.string().min(1).max(8)}).strict().optional()}).strict()}).strict();
function failure(error:unknown,stage:string,id:string){console.error("claim_action_failed",{stage,caseId:id,errorType:error instanceof Error ? error.name : "unknown",message:error instanceof Error ? error.message.replace(/(Bearer\s+)[\w.-]+/gi,"$1[omitido]").replace(/eyJ[\w.-]+/g,"[omitido]").slice(0,1000) : "unknown",status:error instanceof ClaimError ? error.status : 503});return NextResponse.json({error:error instanceof ClaimError ? error.message : stage === "prepare" ? "Falha na consulta das opções. Tente abrir a ação novamente." : "Falha ao validar ou enfileirar a operação. Tente novamente com esta confirmação."},{status:error instanceof ClaimError ? error.status : 503});}
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
  const { id } = await params;const user=await getCurrentUser();if(!user)return NextResponse.json({error:"Sessão expirada."},{status:401});
  const action=new URL(request.url).searchParams.get("action") || "";
  if(action === "return_cost"){try{return NextResponse.json({returnCost:await readClaimReturnCost(id)},{headers:{"Cache-Control":"no-store"}});}catch(error){return failure(error,"return_cost",id);}}
  if(!Object.hasOwn(CLAIM_ACTION_LABELS,action))return NextResponse.json({error:"Ação não habilitada."},{status:400});
  try{return NextResponse.json(await prepareClaimAction(id,action as ClaimAction,user.id),{headers:{"Cache-Control":"no-store"}});}catch(error){return failure(error,"prepare",id);}
}
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
  const { id } = await params;const user=await getCurrentUser();if(!user)return NextResponse.json({error:"Sessão expirada."},{status:401});
  try{const parsed=body.safeParse(await request.json());if(!parsed.success)return NextResponse.json({error:"Dados da confirmação inválidos."},{status:400});
    const operationId=await queueClaimOperation(id,parsed.data,user.id,user.name);return NextResponse.json({operationId,status:"queued"},{status:202});
  }catch(error){return failure(error,"enqueue",id);}
}
