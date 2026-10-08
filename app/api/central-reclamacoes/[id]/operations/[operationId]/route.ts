import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { loadClaimCase } from "@/lib/marketplace-claim-service";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadCaseDetail } from "@/lib/marketplace-case-detail";
export const dynamic="force-dynamic";
export async function GET(_request:Request,{params}:{params: Promise<{id:string;operationId:string}>}){
  const resolvedParams = await params;
  if(!await getCurrentUser())return NextResponse.json({error:"Sessão expirada."},{status:401});
  if(!/^[0-9a-f-]{36}$/i.test(resolvedParams.operationId))return NextResponse.json({error:"Operação inválida."},{status:400});
  try{const db=supabaseAdmin(),row=await loadClaimCase(resolvedParams.id,db);
    const result=await db.from("outgoing_marketplace_activities").select("id,status,remote_execution_state,processing_error").eq("id",resolvedParams.operationId)
      .eq("source_id",resolvedParams.id).eq("marketplace_account_id",row.marketplace_account_id).eq("activity_type","claim_action").maybeSingle().throwOnError();
    if(!result.data)return NextResponse.json({error:"Operação não encontrada."},{status:404});
    const confirmed=result.data.remote_execution_state === "confirmed";
    return NextResponse.json({...result.data,detail:confirmed ? await loadCaseDetail(resolvedParams.id,db) : null},{headers:{"Cache-Control":"no-store"}});
  }catch{return NextResponse.json({error:"Não foi possível ler a confirmação local."},{status:503});}
}
