## Indeed 10K Jobs Production-Safe Preset

This scraper is specifically tuned for high-volume Indeed scraping (IN / US / UK) with the following features:

- **High Speed**: Powered by `CheerioCrawler` for maximum efficiency.
- **Production Tuned**: Stable 2–4 hour runs for up to 10,000 jobs.
- **Anti-Blocking**: Optimized session management and residential proxy support.
- **Smart Pagination**: "No login wall on page-2" logic via session consistency.
- **Bulk Support**: Process multiple queries in a single execution.
- **Persistence**: Remembers already scraped jobs to avoid duplicates across runs.

## Resources

- [Crawlee documentation](https://crawlee.dev)
- [Indeed Scraper Best Practices](https://apify.com/web-scraping/indeed-scraper)


## Getting started

For complete information [see this article](https://docs.apify.com/platform/actors/development#build-actor-locally). To run the Actor use the following command:

```bash
apify run
```

## Deploy to Apify

### Connect Git repository to Apify

If you've created a Git repository for the project, you can easily connect to Apify:

1. Go to [Actor creation page](https://console.apify.com/actors/new)
2. Click on **Link Git Repository** button

### Push project on your local machine to Apify

You can also deploy the project on your local machine to Apify without the need for the Git repository.

1. Log in to Apify. You will need to provide your [Apify API Token](https://console.apify.com/account/integrations) to complete this action.

    ```bash
    apify login
    ```

2. Deploy your Actor. This command will deploy and build the Actor on the Apify Platform. You can find your newly created Actor under [Actors -> My Actors](https://console.apify.com/actors?tab=my).

    ```bash
    apify push
    ```

## Documentation reference

To learn more about Apify and Actors, take a look at the following resources:

- [Apify SDK for JavaScript documentation](https://docs.apify.com/sdk/js)
- [Apify SDK for Python documentation](https://docs.apify.com/sdk/python)
- [Apify Platform documentation](https://docs.apify.com/platform)
- [Join our developer community on Discord](https://discord.com/invite/jyEM2PRvMU)
