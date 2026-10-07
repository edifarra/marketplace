import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { CLAIM_ACTION_LABELS,ClaimAction,ClaimError } from "@/lib/marketplace-claim-domain";
import { prepareClaimAction,queueClaimOperation } from "@/lib/marketplace-claim-service";
import { z } from "zod";
export const dynamic="force-dynamic";
const body=z.object({operationId:z.string().uuid(),context:z.record(z.unknown()),token:z.string().length(64),parameters:z.object({message:z.string().trim().min(1).max(4000).optional(),offer:z.object({percentage:z.number().gt(0).lt(100),amount:z.number().positive(),currency:z.string().min(1).max(8)}).strict().optional()}).strict()}).strict();
function failure(error:unknown){return NextResponse.json({error:error instanceof ClaimError ? error.message : "Não foi possível consultar ou registrar a ação. Tente novamente."},{status:error instanceof ClaimError ? error.status : 503});}
export async function GET(request:Request,{params}:{params:{id:string}}){
  const user=await getCurrentUser();if(!user)return NextResponse.json({error:"Sessão expirada."},{status:401});
  const action=new URL(request.url).searchParams.get("action") || "";
  if(!Object.hasOwn(CLAIM_ACTION_LABELS,action))return NextResponse.json({error:"Ação não habilitada."},{status:400});
  try{return NextResponse.json(await prepareClaimAction(params.id,action as ClaimAction,user.id),{headers:{"Cache-Control":"no-store"}});}catch(error){return failure(error);}
}
export async function POST(request:Request,{params}:{params:{id:string}}){
  const user=await getCurrentUser();if(!user)return NextResponse.json({error:"Sessão expirada."},{status:401});
  try{const parsed=body.safeParse(await request.json());if(!parsed.success)return NextResponse.json({error:"Dados da confirmação inválidos."},{status:400});
    const operationId=await queueClaimOperation(params.id,parsed.data,user.id,user.name);return NextResponse.json({operationId,status:"queued"},{status:202});
  }catch(error){return failure(error);}
}
