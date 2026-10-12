"use client";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
export default function WorkspaceError({reset}:{error:Error;reset:()=>void}) {return <div role="alert" className="page-container"><AlertCircle size={28} className="mb-5 text-warning"/><h1 className="page-title">This view could not be loaded.</h1><p className="mb-6 mt-3 max-w-lg text-sm leading-6 text-muted">Your data has not been changed. Check your connection and try again. If this continues, ask your workspace administrator to check the service configuration.</p><Button onClick={reset} variant="accent">Try again</Button></div>}
