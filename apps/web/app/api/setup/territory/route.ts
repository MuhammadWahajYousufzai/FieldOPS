import { createHash, randomUUID } from "node:crypto";
import { ID, Permission, Query, Role } from "node-appwrite";
import { NextResponse } from "next/server";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { requireDashboardAdmin } from "../../../../lib/auth";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";
const stableId = (prefix:string,value:string)=>`${prefix}_${createHash("sha256").update(value).digest("hex").slice(0,24)}`;
const text = (value:unknown,max:number) => typeof value === "string" ? value.trim().slice(0,max) : "";

export async function POST(request:Request){
  const actor=await requireDashboardAdmin();
  if(!actor)return NextResponse.json({error:"You do not have permission to manage sales areas."},{status:403});
  const body=await request.json();
  const regionName=text(body.regionName,128),regionCode=text(body.regionCode,32).toUpperCase();
  const areaName=text(body.areaName,128),areaCode=text(body.areaCode,32).toUpperCase();
  const territoryName=text(body.territoryName,128);
  if(!regionName||!regionCode||!areaName||!areaCode||!territoryName)return NextResponse.json({error:"Complete every hierarchy field."},{status:400});
  const territoryCode=`TER-${createHash("sha256").update(`${areaCode}:${territoryName.trim().toLowerCase()}`).digest("hex").slice(0,10).toUpperCase()}`;
  const db=createAdminTablesDb();
  const organizations=await db.listRows({databaseId,tableId:"organizations",queries:[Query.equal("active",true),Query.limit(1)]});
  const organization=organizations.rows[0]; if(!organization)return NextResponse.json({error:"Create the organization first."},{status:409});
  const permissions=[Permission.read(Role.user(actor.user.$id))];
  const regionId=stableId("reg",`${organization.$id}:${regionCode}`),areaId=stableId("area",`${regionId}:${areaCode}`),territoryId=stableId("ter",`${areaId}:${territoryCode}`);
  try{
    try{await db.getRow({databaseId,tableId:"regions",rowId:regionId})}catch(error){if(typeof error==="object"&&error&&"code" in error&&Number(error.code)===404)await db.createRow({databaseId,tableId:"regions",rowId:regionId,data:{organization_id:organization.$id,code:regionCode,name:regionName,active:true},permissions});else throw error}
    try{await db.getRow({databaseId,tableId:"areas",rowId:areaId})}catch(error){if(typeof error==="object"&&error&&"code" in error&&Number(error.code)===404)await db.createRow({databaseId,tableId:"areas",rowId:areaId,data:{region_id:regionId,code:areaCode,name:areaName,active:true},permissions});else throw error}
    await db.createRow({databaseId,tableId:"territories",rowId:territoryId,data:{area_id:areaId,code:territoryCode,name:territoryName,active:true},permissions});
    await db.createRow({databaseId,tableId:"audit_logs",rowId:ID.unique(),data:{actor_user_id:actor.user.$id,action:"territory.hierarchy_created",entity_type:"territory",entity_id:territoryId,occurred_at:new Date().toISOString(),after_json:JSON.stringify({regionId,regionCode,areaId,areaCode,territoryId,territoryCode}),reason:"Initial organization setup",correlation_id:randomUUID()},permissions});
    return NextResponse.json({ok:true,territoryId},{status:201});
  }catch(error){
    const code=typeof error==="object"&&error&&"code" in error?Number(error.code):500;
    return NextResponse.json({error:code===409?"This code already exists. Use a different code.":"The hierarchy could not be saved."},{status:code===409?409:500});
  }
}
