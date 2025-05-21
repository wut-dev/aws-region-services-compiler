const AWS = require('aws-sdk');

// Set the AWS region and credentials from environment variables
// AWS.config.update({
//     region: process.env.AWS_REGION || 'us-east-1',
//     credentials: new AWS.Credentials({
//         accessKeyId: process.env.AWS_ACCESS_KEY_ID,
//         secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
//         sessionToken: process.env.AWS_SESSION_TOKEN
//     })
// });

const sts = new AWS.STS();
const ssm = new AWS.SSM();
const s3 = new AWS.S3();

// Add delay helper function
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Add retry helper function after the delay helper
const retryWithBackoff = async (operation, initialDelay = 1000, maxRetries = 5) => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            console.log(error);
            if (error.code === 'ThrottlingException' && attempt < maxRetries) {
                const backoffDelay = initialDelay * attempt;
                console.log(`Rate limited. Retrying in ${backoffDelay/1000}s... (Attempt ${attempt})`);
                await delay(backoffDelay);
                continue;
            }
            throw error;
        }
    }
};

async function loadRegions() {
    // First get list of all regions
    const regionsParams = {
        Path: '/aws/service/global-infrastructure/regions',
    };
    
    console.log(`Fetching regions from SSM: ${regionsParams.Path}`);
    const regionsResponse = await ssm.getParametersByPath(regionsParams).promise();
    let regionsList = [];
    let nextToken = regionsResponse.NextToken;
    
    // Add parameters from initial response
    regionsList.push(...regionsResponse.Parameters.map(param => param.Value));
    
    // Keep fetching while there are more pages
    while (nextToken) {
        const nextResponse = await ssm.getParametersByPath({
            ...regionsParams,
            NextToken: nextToken
        }).promise();
        regionsList.push(...nextResponse.Parameters.map(param => param.Value));
        nextToken = nextResponse.NextToken;
    }
    
    // For each region, get its detailed parameters
    const regionsDetails = await Promise.all(regionsList.map(async (region) => {
        const detailParams = {
            Path: `/aws/service/global-infrastructure/regions/${region}`
        };

        console.log(`Fetching region details from SSM: ${detailParams.Path}`);
        
        const details = await ssm.getParametersByPath(detailParams).promise();
        
        // Convert array of parameters into an object with proper properties
        const regionInfo = {
            name: region
        };
        
        details.Parameters.forEach(param => {
            // Extract the property name from the path
            const propertyName = param.Name.split('/').pop();
            regionInfo[propertyName] = param.Value;
        });
        
        return regionInfo;
    }));

    return regionsDetails;
}

async function loadServices(serviceList = null) {
    // Get all regions using existing function
    const regionsDetails = await loadRegions();
    const allRegions = regionsDetails.map(region => region.name);

    const returnMap = {
        regions: regionsDetails,
        services: []
    };

    let servicesList = [];
    
    if (serviceList) {
        console.log(`Using provided services list: ${serviceList}`);
        servicesList = serviceList;
    } else {
        console.log(`Fetching all AWS services`);
        // Get list of all AWS services
        const servicesParams = {
            Path: '/aws/service/global-infrastructure/services'
        };
        
        console.log(`Fetching services from SSM: ${servicesParams.Path}`);
        const servicesResponse = await ssm.getParametersByPath(servicesParams).promise();
        let nextToken = servicesResponse.NextToken;
        
        // Process initial response
        const initialServices = servicesResponse.Parameters.map(param => param.Name.split('/').pop());
        servicesList.push(...initialServices);
        
        // Keep fetching while there are more pages
        while (nextToken) {
            const nextResponse = await ssm.getParametersByPath({
                ...servicesParams,
                NextToken: nextToken
            }).promise();
            const pageServices = nextResponse.Parameters.map(param => param.Name.split('/').pop());
            servicesList.push(...pageServices);
            nextToken = nextResponse.NextToken;
        }
    }

    // For each service, get its detailed parameters and regions with delay between calls
    for (const service of servicesList) {
        try {
            // Get service details with retry
            const detailParams = {
                Path: `/aws/service/global-infrastructure/services/${service}`,
                Recursive: false
            };
            
            console.log(`Fetching service details from SSM: ${detailParams.Path}`);
            const details = await retryWithBackoff(() => 
                ssm.getParametersByPath(detailParams).promise()
            );
            
            // Convert array of parameters into an object with proper properties
            let serviceInfo = {
                service: service
            };
            
            details.Parameters.forEach(param => {
                const propertyName = param.Name.split('/').pop();
                serviceInfo[propertyName] = param.Value;
            });

            // Get service regions with retry
            const regionsParams = {
                Path: `/aws/service/global-infrastructure/services/${service}/regions`
            };
            
            console.log(`Fetching service regions from SSM: ${regionsParams.Path}`);

            let supportedRegions = new Set();
            const regionsResponse = await retryWithBackoff(() => 
                ssm.getParametersByPath(regionsParams).promise()
            );
            
            // Add regions from initial response
            regionsResponse.Parameters.forEach(param => {
                supportedRegions.add(param.Value);
            });
            
            // Handle pagination for regions with retry
            let regionsNextToken = regionsResponse.NextToken;
            while (regionsNextToken) {
                const nextRegionsResponse = await retryWithBackoff(() => 
                    ssm.getParametersByPath({
                        ...regionsParams,
                        NextToken: regionsNextToken
                    }).promise()
                );
                nextRegionsResponse.Parameters.forEach(param => {
                    supportedRegions.add(param.Value);
                });
                regionsNextToken = nextRegionsResponse.NextToken;
            }

            // Create regions object with boolean values
            let regionsMap = {};
            allRegions.forEach(region => {
                regionsMap[region] = supportedRegions.has(region);
            });

            // Sort the properties of the regionMap alphabetically
            regionsMap = Object.fromEntries(
                Object.entries(regionsMap).sort(([a], [b]) => a.localeCompare(b))
            );

            // Move all the regionMap properties to the top-level of the serviceInfo object
            serviceInfo = { ...serviceInfo, ...regionsMap };

            returnMap.services.push(serviceInfo);

            // Add delay between service calls to avoid throttling
            await delay(1500);
            
        } catch (error) {
            console.error(`Error processing service ${service}:`, error);
            continue;
        }
    }

    // Sort services array by service name before returning
    returnMap.services.sort((a, b) => a.service.localeCompare(b.service));

    return returnMap;
}

// Add upload helper function before the handler
async function uploadToS3(data) {
    const bucket = process.env.S3_BUCKET_NAME;
    if (!bucket) {
        throw new Error('S3_BUCKET_NAME environment variable is not set');
    }

    const uploads = [
        {
            Key: 'data/regions.json',
            Body: JSON.stringify({regions: data.regions}, null, 2)
        },
        {
            Key: 'data/services.json',
            Body: JSON.stringify({services: data.services}, null, 2)
        }
    ];

    console.log(`Uploading files to S3 bucket: ${bucket}`);
    
    await Promise.all(uploads.map(file => 
        s3.putObject({
            Bucket: bucket,
            Key: file.Key,
            Body: file.Body,
            ContentType: 'application/json'
        }).promise()
    ));

    console.log('Successfully uploaded files to S3');
}

// Modify the handler to include the upload
exports.handler = async (event, context, callback) => {
    try {
        const identity = await sts.getCallerIdentity().promise();
        console.log('Caller Identity:', identity);

        const testServices = event.services || null;
        const services = await loadServices(testServices);
        
        // Upload results to S3
        if (!event.skipS3Upload) await uploadToS3(services);
        
        callback(null, services);
        
    } catch (error) {
        console.error('Error:', error);
        callback(error);
    }
};

// Add local test execution with test services
// Uncomment this to run locally
// if (require.main === module) {
//     console.log('Running handler locally...');
//     const testEvent = {
//         services: ['connect', 'athena'], // Test with specific services
//         skipS3Upload: true
//     };
//     exports.handler(testEvent, {}, (error, result) => {
//         if (error) {
//             console.error('Handler failed:', error);
//         } else {
//             console.log('Handler succeeded:', JSON.stringify(result, null, 2));
//         }
//     });
// }