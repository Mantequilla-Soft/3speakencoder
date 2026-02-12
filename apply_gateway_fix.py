#!/usr/bin/env python3
"""Apply the critical gateway reporting fix for /myJob jobs."""

import re

FILE_PATH = 'src/services/ThreeSpeakEncoder.ts'

def apply_fix():
    with open(FILE_PATH, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Fix 1: Add tracking flags after ownershipCheckInterval declaration
    pattern1 = r'(let ownershipCheckInterval: NodeJS\.Timeout \| null = null;)\s*\n\s*\n(\s*// .* Check if job was queued)'
    replacement1 = r'''\1
    
    // 🎯 Track job source to determine if we should report to gateway
    let isAutoAssignedFromMyJob = false; // Jobs from /myJob - already assigned, SHOULD report progress
    let isManualForceProcessing = ownershipAlreadyConfirmed; // Manual force processing - skip gateway entirely
    
\2'''
    content = re.sub(pattern1, replacement1, content)
    
    # Fix 2: Update the /myJob detection block
    pattern2 = r'(// .* Check if job was queued with ownership already confirmed.*?\n\s*if \(job\.ownershipAlreadyConfirmed === true)\) \{\s*\n\s*ownershipAlreadyConfirmed = true;\s*\n\s*logger\.info\(`✅ Job \$\{jobId\} queued with ownership pre-confirmed \(/myJob auto-assignment\)`\);\s*\n\s*\}'
    replacement2 = r'''\1 && !ownershipAlreadyConfirmed) {
      ownershipAlreadyConfirmed = true;
      isAutoAssignedFromMyJob = true; // Flag that this came from /myJob
      isManualForceProcessing = false; // Not manual - SHOULD report to gateway
      logger.info(`✅ Job ${jobId} queued with ownership pre-confirmed (/myJob auto-assignment)`);
      logger.info(`📡 Will report progress and completion to gateway`);
    }'''
    content = re.sub(pattern2, replacement2, content, flags=re.DOTALL)
    
    # Fix 3: Update defensive takeover block
    pattern3 = r'(if \(this\.defensiveTakeoverJobs\.has\(jobId\)\) \{\s*\n\s*logger\.info\(`🔒 DEFENSIVE_OVERRIDE.*?\);\s*\n\s*ownershipAlreadyConfirmed = true; // Force skip all gateway interactions)\s*\n\s*\}'
    replacement3 = r'''\1
      isManualForceProcessing = true; // This is offline processing
      isAutoAssignedFromMyJob = false; // Override - treat as manual
    }'''
    content = re.sub(pattern3, replacement3, content, flags=re.DOTALL)
    
    # Fix 4: Add shouldReportToGateway variable before gateway ping
    pattern4 = r'(// Update status to running using legacy-compatible format\s*\n\s*job\.status = JobStatus\.RUNNING;)\s*\n\s*\n\s*(// .* SKIP_GATEWAY_PINGS:.*?\n\s*if \(!ownershipAlreadyConfirmed && !usedMongoDBFallback && !usedGatewayAidFallback\) \{)'
    replacement4 = r'''\1
      
      // 🎯 GATEWAY_REPORTING: Report to gateway unless in manual/offline mode
      // Skip reporting ONLY for: manual force processing, MongoDB fallback, or Gateway Aid fallback
      // DO report for: auto-assigned /myJob jobs (isAutoAssignedFromMyJob = true)
      const shouldReportToGateway = !isManualForceProcessing && !usedMongoDBFallback && !usedGatewayAidFallback;
      
      if (shouldReportToGateway) {'''
    content = re.sub(pattern4, replacement4, content, flags=re.DOTALL)
    
    # Fix 5: Update progress reporting comments and condition
    pattern5 = r'// .* SKIP_GATEWAY_PINGS: Skip progress pings.*?\n\s*if \(!ownershipAlreadyConfirmed && !usedMongoDBFallback && !usedGatewayAidFallback\) \{'
    replacement5 = r'''// 🎯 GATEWAY_REPORTING: Report progress unless in manual/offline mode
          if (shouldReportToGateway) {'''
    content = re.sub(pattern5, replacement5, content)
    
    # Fix 6: Update finishJob condition
    pattern6 = r'(// Complete the job with gateway.*?\n.*?\n.*?\n\s*if \()!ownershipAlreadyConfirmed && !usedMongoDBFallback && !usedGatewayAidFallback\)'
    replacement6 = r'\1shouldReportToGateway)'
    content = re.sub(pattern6, replacement6, content, flags=re.DOTALL)
    
    # Fix 7: Update skip message
    pattern7 = r'"manual mode"'
    replacement7 = r'"manual force processing"'
    content = content.replace(pattern7, replacement7)
    
    # Fix 8: Update error reporting condition
    pattern8 = r'if \(shouldReportFailure && !ownershipAlreadyConfirmed && !usedMongoDBFallback && !usedGatewayAidFallback\)'
    replacement8 = r'if (shouldReportFailure && shouldReportToGateway)'
    content = re.sub(pattern8, replacement8, content)
    
    # Fix 9: Update else-if for fallback failure reporting
    pattern9 = r'(\} else if \(shouldReportFailure && )\(ownershipAlreadyConfirmed \|\| usedMongoDBFallback \|\| usedGatewayAidFallback\)(\) \{\s*\n\s*const reason = )ownershipAlreadyConfirmed \? "manual processing" :'
    replacement9 = r'\1!shouldReportToGateway\2isManualForceProcessing ? "manual processing" :'
    content = re.sub(pattern9, replacement9, content, flags=re.DOTALL)
    
    with open(FILE_PATH, 'w', encoding='utf-8') as f:
        f.write(content)
    
    print("✅ Gateway reporting fix applied successfully!")
    print("📡 /myJob jobs will now report progress and completion to gateway")
    print("🔒 Manual force processing jobs will continue to skip gateway reporting")

if __name__ == '__main__':
    apply_fix()
