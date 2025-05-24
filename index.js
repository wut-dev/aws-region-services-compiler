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

// Modify the handler to include the upload
exports.handler = async (event, context) => {
    // Check if event.body exists and parse it
    let data;
    try {
        if (event.body) {
            data = JSON.parse(event.body);
            
            // Check if data is an array and has at least one element
            if (Array.isArray(data) && data.length > 0) {
                // Check first element has required properties
                if (data[0].uuid && data[0].path && data[0].service) {
                    // Log each object on its own line
                    data.forEach(item => {
                        console.log(JSON.stringify(item));
                    });
                }
            }
        }
    } catch (err) {
        console.error('Error parsing event body:', err);
    }
    
    // Return a response suitable for Lambda Function URL
    return {
        statusCode: 200,
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            status: "success"
        })
    };
};

// Add local test execution with test services
// Uncomment this to run locally
// if (require.main === module) {
//     console.log('Running handler locally...');
//     const testEvent = {
//         "version": "2.0",
//         "routeKey": "$default",
//         "rawPath": "/",
//         "rawQueryString": "",
//         "headers": {
//             "content-type": "application/json"
//         },
//         "requestContext": {
//             "http": {
//                 "method": "POST"
//             }
//         },
//         "body": JSON.stringify({ "test": "data" }),
//         "isBase64Encoded": false
//     };
    
//     exports.handler(testEvent, {})
//         .then(result => console.log('Handler succeeded:', JSON.stringify(result, null, 2)))
//         .catch(error => console.error('Handler failed:', error));
// }