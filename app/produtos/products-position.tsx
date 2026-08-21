"use client";
import { useEffect } from "react";
export function ProductsPosition({ listKey }: { listKey: string }) {
  useEffect(() => { const key=`products-scroll:${listKey}`; const frame=requestAnimationFrame(()=>scrollTo({top:Number(sessionStorage.getItem(key)||0)})); const save=()=>sessionStorage.setItem(key,String(scrollY)); addEventListener("scroll",save,{passive:true}); return()=>{cancelAnimationFrame(frame);save();removeEventListener("scroll",save);}; },[listKey]);
  return null;
}
